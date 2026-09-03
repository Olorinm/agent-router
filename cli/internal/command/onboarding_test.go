package command

import "testing"

func TestInvitationRoundTrip(t *testing.T) {
	want := invitation{
		Version: 1,
		Router:  "router.example.com",
		Address: "writer@router.example.com",
		Token:   "are_test-secret",
	}
	code, err := encodeInvitation(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodeInvitation(code)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("decoded invitation = %#v, want %#v", got, want)
	}
}

func TestInvitationRejectsMalformedInput(t *testing.T) {
	for _, value := range []string{"", "are_secret", "arj1_not-base64", "arj1_e30"} {
		if _, err := decodeInvitation(value); err == nil {
			t.Fatalf("decodeInvitation(%q) unexpectedly succeeded", value)
		}
	}
}

func TestEndpointOrigin(t *testing.T) {
	tests := map[string]string{
		"worker.example.com":                   "https://worker.example.com",
		"https://worker.example.com/a2a/card":  "https://worker.example.com",
		"https://worker.example.com:8443/path": "https://worker.example.com:8443",
	}
	for input, want := range tests {
		got, err := endpointOrigin(input)
		if err != nil {
			t.Fatalf("endpointOrigin(%q): %v", input, err)
		}
		if got != want {
			t.Fatalf("endpointOrigin(%q) = %q, want %q", input, got, want)
		}
	}
	if _, err := endpointOrigin("http://worker.example.com"); err == nil {
		t.Fatal("HTTP endpoint unexpectedly accepted")
	}
}
