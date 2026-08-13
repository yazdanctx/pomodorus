package config

import "testing"

func TestLoad(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantErr bool
		check   func(t *testing.T, c Config)
	}{
		{
			name: "defaults are the local docker-compose stack",
			env:  map[string]string{},
			check: func(t *testing.T, c Config) {
				if c.Addr != ":8081" {
					t.Errorf("Addr = %q, want :8081", c.Addr)
				}
				if !c.IsDev() {
					t.Error("expected development by default")
				}
				if c.FastSessions {
					t.Error("fast sessions must be off unless asked for")
				}
			},
		},
		{
			name: "fast sessions in production is refused",
			env: map[string]string{
				"ENV":           "production",
				"FAST_SESSIONS": "1",
			},
			// A client cannot ask for a fast session, but an env var could —
			// and a production deployment that credits three-second sessions
			// at twenty-five minutes mints focus time out of nothing.
			wantErr: true,
		},
		{
			name:    "an unknown ENV is refused rather than assumed",
			env:     map[string]string{"ENV": "staging"},
			wantErr: true,
		},
		{
			name: "fast sessions in development is allowed",
			env: map[string]string{
				"ENV":           "development",
				"FAST_SESSIONS": "1",
			},
			check: func(t *testing.T, c Config) {
				if !c.FastSessions {
					t.Error("expected fast sessions to be on")
				}
			},
		},
		{
			name: "whitespace-only values fall back rather than being honoured",
			env:  map[string]string{"ADDR": "   "},
			check: func(t *testing.T, c Config) {
				if c.Addr != ":8081" {
					t.Errorf("Addr = %q, want the default", c.Addr)
				}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			// Setenv only sets what the case named; clear the rest so the
			// developer's own shell cannot change the result.
			for _, k := range []string{"ENV", "ADDR", "DATABASE_URL", "FAST_SESSIONS"} {
				if _, ok := tc.env[k]; !ok {
					t.Setenv(k, "")
				}
			}

			c, err := Load()
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected an error, got none")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.check != nil {
				tc.check(t, c)
			}
		})
	}
}
