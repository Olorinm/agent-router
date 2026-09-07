package cli

import (
	"os"
	"testing"

	a2apb "github.com/a2aproject/a2a-go/v2/a2apb/v1"
	"github.com/a2aproject/a2a-go/v2/a2apb/v1/pbconv"
	"google.golang.org/protobuf/encoding/protojson"
)

// Produced by the official TypeScript SDK's AgentCard.toJSON with synthetic data.
func TestOfficialAgentCardProtobufJSON(t *testing.T) {
	data, err := os.ReadFile("testdata/agent-card.json")
	if err != nil {
		t.Fatal(err)
	}
	var wire a2apb.AgentCard
	if err = (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(data, &wire); err != nil {
		t.Fatal(err)
	}
	card, err := pbconv.FromProtoAgentCard(&wire)
	if err != nil {
		t.Fatal(err)
	}
	if len(card.SecurityRequirements) != 1 || len(card.SecurityRequirements[0]) != 1 {
		t.Fatal("lost security requirement")
	}
}
