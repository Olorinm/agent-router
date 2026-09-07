package cli

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const maxResponse = 16 << 20

var safeCode = regexp.MustCompile(`^[a-zA-Z0-9_]+$`)

type httpError struct {
	status int
	code   string
	data   map[string]json.RawMessage
}

func (e *httpError) Error() string {
	if safeCode.MatchString(e.code) {
		return e.code
	}
	return fmt.Sprintf("http_%d", e.status)
}

// Credentials stay on the selected origin; redirects are never followed.
type originTransport struct {
	base  *url.URL
	token string
	next  http.RoundTripper
}

func (t originTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if !sameOrigin(r.URL, t.base) {
		return nil, errors.New("credential_origin_mismatch")
	}
	copy := r.Clone(r.Context())
	copy.Header = r.Header.Clone()
	if t.token != "" {
		copy.Header.Set("Authorization", "Bearer "+t.token)
	}
	return t.next.RoundTrip(copy)
}
func sameOrigin(a, b *url.URL) bool { return a.Scheme == b.Scheme && strings.EqualFold(a.Host, b.Host) }

func transport() (*http.Transport, error) {
	t := http.DefaultTransport.(*http.Transport).Clone()
	// The same explicit private CA works for the Go CLI and the Node connector.
	if ca := os.Getenv("NODE_EXTRA_CA_CERTS"); ca != "" {
		pem, err := os.ReadFile(ca)
		if err != nil {
			return nil, errors.New("cannot_read_extra_ca_certificates")
		}
		pool, err := x509.SystemCertPool()
		if err != nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("invalid_extra_ca_certificates")
		}
		t.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	}
	return t, nil
}
func newHTTP(base, token string) (*http.Client, error) {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid_server_url")
	}
	t, err := transport()
	if err != nil {
		return nil, err
	}
	return &http.Client{Transport: originTransport{u, token, t}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirects_are_not_allowed") }}, nil
}

func request(ctx context.Context, client *http.Client, base, path, method string, body any, headers ...http.Header) (json.RawMessage, error) {
	var encoded io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		encoded = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(base, "/")+path, encoded)
	if err != nil {
		return nil, errors.New("invalid_request_url")
	}
	req.Header.Set("Content-Type", "application/json")
	for _, fields := range headers {
		for key, values := range fields {
			req.Header[key] = append([]string(nil), values...)
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errors.New("network_request_failed (check server, TLS and connectivity)")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	if err != nil {
		return nil, errors.New("response_read_failed")
	}
	if len(data) > maxResponse {
		return nil, errors.New("response_too_large")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var m map[string]json.RawMessage
		_ = json.Unmarshal(data, &m)
		var code string
		_ = json.Unmarshal(m["errcode"], &code)
		if code == "" {
			_ = json.Unmarshal(m["error"], &code)
		}
		return nil, &httpError{resp.StatusCode, code, m}
	}
	if resp.StatusCode == 204 {
		return nil, nil
	}
	if !json.Valid(data) {
		return nil, errors.New("invalid_json_response")
	}
	return data, nil
}
func timedRequest(ctx context.Context, c *http.Client, base, path, method string, body any, headers ...http.Header) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return request(ctx, c, base, path, method, body, headers...)
}

// Resolve and dial the very same checked address, preventing DNS rebinding for optional backends.
func backendHTTP(base, token string, allowLocal bool) (*http.Client, error) {
	c, err := newHTTP(base, token)
	if err != nil {
		return nil, err
	}
	guard := c.Transport.(originTransport)
	if !allowLocal && guard.base.Scheme != "https" {
		return nil, errors.New("a2a_backend_requires_https")
	}
	t := guard.next.(*http.Transport)
	t.Proxy = nil
	t.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, errors.New("backend_dns_failed")
		}
		if len(ips) == 0 {
			return nil, errors.New("backend_dns_empty")
		}
		for _, ip := range ips {
			if !allowLocal && !publicIP(ip.IP) {
				return nil, errors.New("private_backend_address_rejected")
			}
		}
		dialer := net.Dialer{Timeout: 10 * time.Second}
		for _, ip := range ips {
			conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return conn, nil
			}
		}
		return nil, errors.New("backend_connection_failed")
	}
	guard.next = t
	c.Transport = guard
	return c, nil
}
func publicIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	// Match the server's denial of special-purpose and metadata networks.
	for _, cidr := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "2001::/32", "2002::/16", "64:ff9b::/96"} {
		_, block, _ := net.ParseCIDR(cidr)
		if block.Contains(ip) {
			return false
		}
	}
	return true
}
