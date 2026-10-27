package syncmerge

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const folderSchema = 1

// FolderState is the complete, immutable-by-entity state exchanged through a
// cloud-synced directory. Each peer writes only its own file; concurrent peer
// updates therefore never overwrite one another.
type FolderState struct {
	Schema   int                  `json:"schema"`
	DeviceID string               `json:"deviceId"`
	Entities map[string][]Version `json:"entities"`
}

// FolderSync merges all available peer states with local versions and publishes
// the result under deviceID. The caller is responsible for applying entity
// values to its database and persisting the returned local state atomically.
func FolderSync(root, deviceID string, local map[string][]Version) (map[string][]Version, error) {
	if len(deviceID) != 32 || strings.ContainsAny(deviceID, `/\\`) || deviceID == "." || deviceID == ".." {
		return nil, errors.New("invalid sync device id")
	}
	if _, err := hex.DecodeString(deviceID); err != nil {
		return nil, errors.New("invalid sync device id")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, fmt.Errorf("sync folder is unavailable: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("sync path is not a directory")
	}
	peers := filepath.Join(root, "readx-sync", "peers")
	if err := os.MkdirAll(peers, 0o700); err != nil {
		return nil, fmt.Errorf("create sync folder: %w", err)
	}

	groups := make(map[string][][]Version, len(local))
	for key, versions := range local {
		groups[key] = append(groups[key], versions)
	}
	entries, err := os.ReadDir(peers)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), ".json")
		deviceFromName, digestFromName, ok := strings.Cut(name, "-")
		if !ok || len(deviceFromName) != 32 || len(digestFromName) != 64 {
			continue // ignore files owned by other apps in the selected folder
		}
		if _, err := hex.DecodeString(deviceFromName); err != nil {
			continue
		}
		if _, err := hex.DecodeString(digestFromName); err != nil {
			continue
		}
		path := filepath.Join(peers, entry.Name())
		body, readErr := os.ReadFile(path)
		if errors.Is(readErr, fs.ErrNotExist) {
			continue // a cloud provider may be replacing a file during enumeration
		}
		if readErr != nil {
			return nil, fmt.Errorf("read peer state %s: %w", entry.Name(), readErr)
		}
		digest := sha256.Sum256(body)
		if fmt.Sprintf("%x", digest[:]) != digestFromName {
			continue // cloud sync has not finished downloading this immutable blob yet
		}
		var state FolderState
		if err := json.Unmarshal(body, &state); err != nil {
			return nil, fmt.Errorf("peer state %s is invalid JSON: %w", entry.Name(), err)
		}
		if state.Schema != folderSchema || state.DeviceID != deviceFromName || state.Entities == nil {
			return nil, fmt.Errorf("peer state %s has unsupported or inconsistent metadata", entry.Name())
		}
		for key, versions := range state.Entities {
			groups[key] = append(groups[key], versions)
		}
	}

	merged := make(map[string][]Version, len(groups))
	for key, versions := range groups {
		result, err := Merge(versions...)
		if err != nil {
			return nil, fmt.Errorf("merge entity %q: %w", key, err)
		}
		merged[key] = result
	}
	state := FolderState{Schema: folderSchema, DeviceID: deviceID, Entities: merged}
	body, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(body)
	name := fmt.Sprintf("%s-%x.json", deviceID, digest[:])
	if err := atomicWrite(filepath.Join(peers, name), body); err != nil {
		return nil, fmt.Errorf("publish local sync state: %w", err)
	}
	// The newly published state is a full merge of everything this device saw.
	// Retaining its older snapshots would duplicate every book/page on each later
	// change. Keep other devices' snapshots: their next sync may contain edits
	// that have not reached this device yet.
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" || entry.Name() == name || !strings.HasPrefix(entry.Name(), deviceID+"-") {
			continue
		}
		oldPath := filepath.Join(peers, entry.Name())
		_ = os.Remove(oldPath) // compaction is best effort; the new full state is already durable
	}
	return merged, nil
}

// NewDeviceID creates an opaque stable identifier. Store it locally and never
// regenerate it for ordinary syncs.
func NewDeviceID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func atomicWrite(path string, body []byte) error {
	if existing, err := os.ReadFile(path); err == nil {
		if string(existing) == string(body) {
			return nil
		}
		return errors.New("content-addressed sync file has unexpected contents")
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return err
	}
	temp := path + "." + hex.EncodeToString(suffix[:]) + ".tmp"
	f, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(body)
	syncErr := f.Sync()
	closeErr := f.Close()
	if writeErr != nil {
		_ = os.Remove(temp)
		return writeErr
	}
	if syncErr != nil {
		_ = os.Remove(temp)
		return syncErr
	}
	if closeErr != nil {
		_ = os.Remove(temp)
		return closeErr
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		if existing, readErr := os.ReadFile(path); readErr == nil && string(existing) == string(body) {
			return nil
		}
		return err
	}
	return nil
}
