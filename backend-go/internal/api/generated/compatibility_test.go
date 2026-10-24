package generated_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"agents-board/backend-go/internal/api/generated"
	"github.com/getkin/kin-openapi/openapi3"
	"gopkg.in/yaml.v3"
)

func TestOpenAPI31Semantics(t *testing.T) {
	specification, err := generated.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	if specification.OpenAPI != "3.1.1" {
		t.Fatalf("contract was downgraded: %s", specification.OpenAPI)
	}
	if err := specification.Validate(context.Background()); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, schema, body string
		valid              bool
	}{
		{"nullable", "Evidence", `{"level":"observed","basis":"native_task_event","observedAt":null,"sourceVersion":null,"reason":null}`, true},
		{"nullable time", "Evidence", `{"level":"observed","basis":"native_task_event","observedAt":"2026-10-24T02:30:00Z","sourceVersion":null,"reason":null}`, true},
		{"invalid date", "Evidence", `{"level":"observed","basis":"native_task_event","observedAt":"yesterday","sourceVersion":null,"reason":null}`, false},
		{"required nullable omitted", "Evidence", `{"level":"observed","basis":"native_task_event","sourceVersion":null,"reason":null}`, false},
		{"wrong nullable type", "Evidence", `{"level":"observed","basis":"native_task_event","observedAt":42,"sourceVersion":null,"reason":null}`, false},
		{"enum", "Health", `{"status":"ok","mode":"bogus"}`, false},
		{"const", "Health", `{"status":"wrong","mode":"in-memory-demo"}`, false},
		{"additional property", "AddHostRequest", `{"target":"test","secret":"not-allowed"}`, false},
		{"required", "AddHostRequest", `{}`, false},
		{"valid host", "AddHostRequest", `{"target":"test"}`, true},
		{"valid queued", "RefreshJob", `{"id":"job","sessionId":"session","status":"queued","requestedAt":"2026-10-24T02:30:00Z","startedAt":null,"finishedAt":null,"expiresAt":null,"collectionVersion":null,"error":null}`, true},
		{"invalid succeeded", "RefreshJob", `{"id":"job","sessionId":"session","status":"succeeded","requestedAt":"2026-10-24T02:30:00Z","startedAt":null,"finishedAt":null,"expiresAt":null,"collectionVersion":null,"error":null}`, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var value any
			if err := json.Unmarshal([]byte(test.body), &value); err != nil {
				t.Fatal(err)
			}
			err := specification.Components.Schemas[test.schema].Value.VisitJSON(value, openapi3.EnableJSONSchema2020())
			if (err == nil) != test.valid {
				t.Fatalf("valid = %v, validation error = %v", test.valid, err)
			}
		})
	}
}

func TestGeneratedNullableRoundTrip(t *testing.T) {
	var evidence generated.Evidence
	if err := json.Unmarshal([]byte(`{"level":"observed","basis":"native_task_event","observedAt":null,"sourceVersion":null,"reason":null}`), &evidence); err != nil {
		t.Fatal(err)
	}
	if !evidence.ObservedAt.IsNull() || !evidence.SourceVersion.IsNull() || !evidence.Reason.IsNull() {
		t.Fatal("explicit null was lost")
	}
	if !evidence.ObservedAt.IsSpecified() {
		t.Fatal("explicit null must remain specified")
	}
	var omitted generated.Evidence
	if err := json.Unmarshal([]byte(`{"level":"observed","basis":"native_task_event","sourceVersion":null,"reason":null}`), &omitted); err != nil {
		t.Fatal(err)
	}
	if omitted.ObservedAt.IsSpecified() {
		t.Fatal("omitted and explicit-null values must remain distinguishable")
	}
	encoded, err := json.Marshal(evidence)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(encoded, []byte(`"observedAt":null`)) {
		t.Fatalf("nullable field was omitted: %s", encoded)
	}
}

func TestGenerationIsReproducible(t *testing.T) {
	root := filepath.Join("..", "..", "..")
	output := filepath.Join(t.TempDir(), "api.gen.go")
	configBytes, err := os.ReadFile(filepath.Join(root, "oapi-codegen.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := yaml.Unmarshal(configBytes, &config); err != nil {
		t.Fatal(err)
	}
	config["output"] = output
	configBytes, err = json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(configPath, configBytes, 0600); err != nil {
		t.Fatal(err)
	}
	goBinary := filepath.Join(runtime.GOROOT(), "bin", "go")
	if runtime.GOOS == "windows" {
		goBinary += ".exe"
	}
	command := exec.Command(goBinary, "tool", "oapi-codegen", "-config", configPath, "../_docs/api/openapi.json")
	command.Dir = root
	if result, err := command.CombinedOutput(); err != nil {
		t.Fatalf("generation failed: %v\n%s", err, result)
	}
	actual, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := os.ReadFile("api.gen.go")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, expected) {
		t.Fatal("generated code differs; regenerate from the unique OpenAPI source")
	}
}
