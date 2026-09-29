package platform

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

type aiResource struct {
	EndpointID   string `json:"endpointId"`
	ModelID      string `json:"modelId"`
	KeyID        string `json:"keyId"`
	BaseURL      string `json:"baseUrl"`
	Model        string `json:"model"`
	Protocol     string `json:"protocol"`
	MaskedKey    string `json:"maskedKey"`
	EncryptedKey string `json:"-"`
}
type aiConfigInput struct {
	BaseURL string `json:"baseUrl" validate:"required,url,max=2048"`
	Model   string `json:"model" validate:"required,max=128"`
	APIKey  string `json:"apiKey" validate:"min=8,max=512"`
}

func (a *App) aiCipher() (cipher.AEAD, error) {
	raw, e := base64.StdEncoding.DecodeString(a.Config.AIKey)
	if e != nil || len(raw) != 32 {
		return nil, fail(503, "AI_CONFIG_UNAVAILABLE")
	}
	block, e := aes.NewCipher(raw)
	if e != nil {
		return nil, e
	}
	return cipher.NewGCM(block)
}
func (a *App) encryptAI(secret string) (string, error) {
	c, e := a.aiCipher()
	if e != nil {
		return "", e
	}
	nonce := make([]byte, c.NonceSize())
	if _, e = rand.Read(nonce); e != nil {
		return "", e
	}
	ciphertext := c.Seal(nil, nonce, []byte(secret), nil)
	size := c.Overhead()
	raw, e := json.Marshal(map[string]any{"v": 1, "iv": base64.StdEncoding.EncodeToString(nonce), "ciphertext": base64.StdEncoding.EncodeToString(ciphertext[:len(ciphertext)-size]), "tag": base64.StdEncoding.EncodeToString(ciphertext[len(ciphertext)-size:])})
	return string(raw), e
}
func (a *App) decryptAI(value string) (string, error) {
	var data struct {
		V          int    `json:"v"`
		IV         string `json:"iv"`
		Ciphertext string `json:"ciphertext"`
		Tag        string `json:"tag"`
	}
	if json.Unmarshal([]byte(value), &data) != nil || data.V != 1 {
		return "", errors.New("invalid key")
	}
	iv, e := base64.StdEncoding.DecodeString(data.IV)
	if e != nil {
		return "", e
	}
	ciphertext, e := base64.StdEncoding.DecodeString(data.Ciphertext)
	if e != nil {
		return "", e
	}
	tag, e := base64.StdEncoding.DecodeString(data.Tag)
	if e != nil {
		return "", e
	}
	c, e := a.aiCipher()
	if e != nil {
		return "", e
	}
	if len(iv) != c.NonceSize() || len(tag) != c.Overhead() {
		return "", errors.New("invalid key")
	}
	raw, e := c.Open(nil, iv, append(ciphertext, tag...), nil)
	return string(raw), e
}
func (a *App) resources(ctx context.Context) ([]aiResource, error) {
	rows, e := a.DB.Query(ctx, "SELECT e.id,m.id,k.id,e.base_url,m.name,k.last4,k.encrypted_key FROM ai_endpoints e JOIN ai_models m ON m.endpoint_id=e.id JOIN ai_keys k ON k.endpoint_id=e.id WHERE e.enabled AND m.enabled AND k.enabled ORDER BY m.id,k.id")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []aiResource{}
	for rows.Next() {
		var x aiResource
		var last4 string
		if e = rows.Scan(&x.EndpointID, &x.ModelID, &x.KeyID, &x.BaseURL, &x.Model, &last4, &x.EncryptedKey); e != nil {
			return nil, e
		}
		x.Protocol = "OPENAI_COMPATIBLE"
		x.MaskedKey = "••••" + last4
		out = append(out, x)
	}
	return out, rows.Err()
}
func (a *App) aiResources(w http.ResponseWriter, r *http.Request) error {
	rows, e := a.resources(r.Context())
	if e != nil {
		return e
	}
	jsonOut(w, 200, rows)
	return nil
}
func (a *App) aiConfig(w http.ResponseWriter, r *http.Request) error {
	rows, e := a.DB.Query(r.Context(), "SELECT id,base_url,enabled FROM ai_endpoints ORDER BY base_url")
	if e != nil {
		return e
	}
	endpoints := []map[string]any{}
	for rows.Next() {
		var ID, base string
		var enabled bool
		if e = rows.Scan(&ID, &base, &enabled); e != nil {
			rows.Close()
			return e
		}
		endpoints = append(endpoints, map[string]any{"id": ID, "baseUrl": base, "protocol": "OPENAI_COMPATIBLE", "enabled": enabled, "models": []any{}, "keys": []any{}})
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, item := range endpoints {
		endpointID := item["id"].(string)
		models, e := a.DB.Query(r.Context(), "SELECT id,name,enabled FROM ai_models WHERE endpoint_id=$1 ORDER BY name", endpointID)
		if e != nil {
			return e
		}
		m := []map[string]any{}
		for models.Next() {
			var ID, name string
			var enabled bool
			if e = models.Scan(&ID, &name, &enabled); e != nil {
				models.Close()
				return e
			}
			m = append(m, map[string]any{"id": ID, "name": name, "enabled": enabled})
		}
		e = models.Err()
		models.Close()
		if e != nil {
			return e
		}
		item["models"] = m
		keys, e := a.DB.Query(r.Context(), "SELECT id,last4,enabled FROM ai_keys WHERE endpoint_id=$1 ORDER BY id", endpointID)
		if e != nil {
			return e
		}
		k := []map[string]any{}
		for keys.Next() {
			var ID, last4 string
			var enabled bool
			if e = keys.Scan(&ID, &last4, &enabled); e != nil {
				keys.Close()
				return e
			}
			k = append(k, map[string]any{"id": ID, "maskedKey": "••••" + last4, "enabled": enabled})
		}
		e = keys.Err()
		keys.Close()
		if e != nil {
			return e
		}
		item["keys"] = k
	}
	jsonOut(w, 200, endpoints)
	return nil
}
func validAIURL(value string) (string, error) {
	parsed, e := url.Parse(value)
	if e != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fail(400, "AI_CONFIG_INVALID")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1")) {
		return "", fail(400, "AI_CONFIG_INVALID")
	}
	if !strings.HasSuffix(parsed.Path, "/") {
		parsed.Path += "/"
	}
	return parsed.String(), nil
}
func validAISecret(secret string) bool {
	if len(secret) < 8 || len(secret) > 512 {
		return false
	}
	for _, character := range secret {
		if character <= 32 || character == 127 {
			return false
		}
	}
	return true
}
func (a *App) configureAI(w http.ResponseWriter, r *http.Request) error {
	var in aiConfigInput
	if e := body(r, &in); e != nil {
		return e
	}
	resource, e := a.saveAIResource(r.Context(), in)
	if e != nil {
		return e
	}
	jsonOut(w, 201, resource)
	return nil
}
func (a *App) saveAIResource(ctx context.Context, in aiConfigInput) (aiResource, error) {
	in.Model = trimmed(in.Model)
	if e := a.valid(in); e != nil {
		return aiResource{}, e
	}
	if !validAISecret(in.APIKey) || strings.Contains(in.BaseURL, in.APIKey) || strings.Contains(in.Model, in.APIKey) {
		return aiResource{}, fail(400, "AI_CONFIG_INVALID")
	}
	base, e := validAIURL(in.BaseURL)
	if e != nil {
		return aiResource{}, e
	}
	cipherText, e := a.encryptAI(in.APIKey)
	if e != nil {
		return aiResource{}, e
	}
	digest := sha256.Sum256([]byte(in.APIKey))
	fingerprint := hex.EncodeToString(digest[:])
	last4 := in.APIKey[len(in.APIKey)-4:]
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return aiResource{}, e
	}
	defer tx.Rollback(ctx)
	var endpointID, modelID, keyID string
	e = tx.QueryRow(ctx, "INSERT INTO ai_endpoints(base_url) VALUES($1) ON CONFLICT(base_url) DO UPDATE SET base_url=EXCLUDED.base_url RETURNING id", base).Scan(&endpointID)
	if e != nil {
		return aiResource{}, e
	}
	e = tx.QueryRow(ctx, "INSERT INTO ai_models(endpoint_id,name) VALUES($1,$2) ON CONFLICT(endpoint_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id", endpointID, in.Model).Scan(&modelID)
	if e != nil {
		return aiResource{}, e
	}
	e = tx.QueryRow(ctx, "INSERT INTO ai_keys(endpoint_id,encrypted_key,fingerprint,last4) VALUES($1,$2,$3,$4) ON CONFLICT(endpoint_id,fingerprint) DO UPDATE SET fingerprint=EXCLUDED.fingerprint RETURNING id", endpointID, cipherText, fingerprint, last4).Scan(&keyID)
	if e != nil {
		return aiResource{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return aiResource{}, e
	}
	return aiResource{EndpointID: endpointID, ModelID: modelID, KeyID: keyID, BaseURL: base, Model: in.Model, Protocol: "OPENAI_COMPATIBLE", MaskedKey: "••••" + last4}, nil
}
func (a *App) addAIModel(w http.ResponseWriter, r *http.Request) error {
	endpointID, e := paramID(r)
	if e != nil {
		return e
	}
	var in struct {
		Name string `json:"name" validate:"required,max=128"`
	}
	if e = body(r, &in); e != nil {
		return e
	}
	in.Name = trimmed(in.Name)
	if e = a.valid(in); e != nil {
		return e
	}
	var exists bool
	e = a.DB.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM ai_endpoints WHERE id=$1)", endpointID).Scan(&exists)
	if e != nil {
		return e
	}
	if !exists {
		return fail(404, "AI_RESOURCE_NOT_FOUND")
	}
	_, e = a.DB.Exec(r.Context(), "INSERT INTO ai_models(endpoint_id,name) VALUES($1,$2) ON CONFLICT(endpoint_id,name) DO NOTHING", endpointID, in.Name)
	if e != nil {
		return e
	}
	w.WriteHeader(204)
	return nil
}
func (a *App) addAIKey(w http.ResponseWriter, r *http.Request) error {
	endpointID, e := paramID(r)
	if e != nil {
		return e
	}
	var in struct {
		APIKey string `json:"apiKey" validate:"min=8,max=512"`
	}
	if e = body(r, &in); e != nil {
		return e
	}
	if e = a.valid(in); e != nil {
		return e
	}
	if !validAISecret(in.APIKey) {
		return fail(400, "AI_CONFIG_INVALID")
	}
	encrypted, e := a.encryptAI(in.APIKey)
	if e != nil {
		return e
	}
	sum := sha256.Sum256([]byte(in.APIKey))
	var exists bool
	e = a.DB.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM ai_endpoints WHERE id=$1)", endpointID).Scan(&exists)
	if e != nil {
		return e
	}
	if !exists {
		return fail(404, "AI_RESOURCE_NOT_FOUND")
	}
	_, e = a.DB.Exec(r.Context(), "INSERT INTO ai_keys(endpoint_id,encrypted_key,fingerprint,last4) VALUES($1,$2,$3,$4) ON CONFLICT(endpoint_id,fingerprint) DO NOTHING", endpointID, encrypted, hex.EncodeToString(sum[:]), in.APIKey[len(in.APIKey)-4:])
	if e != nil {
		return e
	}
	w.WriteHeader(204)
	return nil
}
func (a *App) toggleAIEndpoint(w http.ResponseWriter, r *http.Request) error {
	return a.toggleAI(w, r, "ai_endpoints")
}
func (a *App) toggleAIModel(w http.ResponseWriter, r *http.Request) error {
	return a.toggleAI(w, r, "ai_models")
}
func (a *App) toggleAIKey(w http.ResponseWriter, r *http.Request) error {
	return a.toggleAI(w, r, "ai_keys")
}
func (a *App) toggleAI(w http.ResponseWriter, r *http.Request, table string) error {
	resourceID, e := paramID(r)
	if e != nil {
		return e
	}
	var in struct {
		Enabled *bool `json:"enabled"`
	}
	if e = body(r, &in); e != nil {
		return e
	}
	if in.Enabled == nil {
		return fail(400, "VALIDATION_ERROR")
	}
	tag, e := a.DB.Exec(r.Context(), "UPDATE "+table+" SET enabled=$1 WHERE id=$2", *in.Enabled, resourceID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		return fail(404, "AI_RESOURCE_NOT_FOUND")
	}
	w.WriteHeader(204)
	return nil
}
