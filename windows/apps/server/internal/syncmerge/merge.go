// Package syncmerge implements conflict-preserving version merging independently
// of any cloud provider or database. Each device keeps its own monotonic counter.
package syncmerge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

type Clock map[string]uint64

type Version struct {
	Clock   Clock           `json:"clock"`
	Deleted bool            `json:"deleted,omitempty"`
	Value   json.RawMessage `json:"value,omitempty"`
}

// Compare returns -1 if a precedes b, 1 if a follows b, and 0 if equal;
// concurrent versions return 2. Missing entries are zero.
func Compare(a, b Clock) int {
	before, after := false, false
	for id, count := range a {
		if count < b[id] {
			before = true
		}
		if count > b[id] {
			after = true
		}
	}
	for id, count := range b {
		if _, ok := a[id]; !ok && count > 0 {
			before = true
		}
	}
	if before && after {
		return 2
	}
	if before {
		return -1
	}
	if after {
		return 1
	}
	return 0
}

// Advance joins every observed version before recording the local edit. The
// caller persists the device counter atomically with the resulting version.
func Advance(versions []Version, device string, counter uint64, value json.RawMessage, deleted bool) (Version, error) {
	if device == "" || counter == 0 {
		return Version{}, errors.New("device and counter are required")
	}
	clock := Clock{}
	for _, v := range versions {
		if err := validate(v); err != nil {
			return Version{}, err
		}
		for id, n := range v.Clock {
			if n > clock[id] {
				clock[id] = n
			}
		}
	}
	if counter <= clock[device] {
		return Version{}, errors.New("device counter must advance")
	}
	clock[device] = counter
	out := Version{Clock: clock, Deleted: deleted, Value: append(json.RawMessage(nil), value...)}
	if err := validate(out); err != nil {
		return Version{}, err
	}
	return out, nil
}

// Merge retains all maximal concurrent versions, including deletion-versus-edit
// conflicts. It never uses wall-clock time to decide which note to discard.
func Merge(groups ...[]Version) ([]Version, error) {
	var versions []Version
	for _, group := range groups {
		for _, v := range group {
			if err := validate(v); err != nil {
				return nil, err
			}
			v.Clock = cloneClock(v.Clock)
			v.Value = append(json.RawMessage(nil), v.Value...)
			duplicate := false
			for i := range versions {
				existing := &versions[i]
				if Compare(existing.Clock, v.Clock) == 0 && (existing.Deleted != v.Deleted || !bytes.Equal(existing.Value, v.Value)) {
					return nil, errors.New("different contents share the same version clock")
				}
				if existing.Deleted == v.Deleted && bytes.Equal(existing.Value, v.Value) {
					for id, count := range v.Clock {
						if count > existing.Clock[id] {
							existing.Clock[id] = count
						}
					}
					duplicate = true
					break
				}
			}
			if !duplicate {
				versions = append(versions, v)
			}
		}
	}
	result := make([]Version, 0, len(versions))
	for i, v := range versions {
		dominated := false
		for j, other := range versions {
			if i != j && Compare(v.Clock, other.Clock) == -1 {
				dominated = true
				break
			}
		}
		if !dominated {
			result = append(result, v)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		a, _ := json.Marshal(result[i].Clock)
		b, _ := json.Marshal(result[j].Clock)
		return bytes.Compare(a, b) < 0
	})
	return result, nil
}

// Reconcile compares a local database snapshot with the last state applied by
// this device, records local edits/deletions, then merges them with peer state.
// The returned base must be stored locally only after database application
// succeeds. Counter is the device's persisted next sequence number.
func Reconcile(device string, counter uint64, observed map[string]json.RawMessage, base, peers map[string][]Version) (map[string][]Version, uint64, error) {
	keys := make(map[string]struct{}, len(observed)+len(base)+len(peers))
	for key := range observed {
		keys[key] = struct{}{}
	}
	for key := range base {
		keys[key] = struct{}{}
	}
	for key := range peers {
		keys[key] = struct{}{}
	}
	merged := make(map[string][]Version, len(keys))
	ordered := make([]string, 0, len(keys))
	for key := range keys {
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	for _, key := range ordered {
		localBase := base[key]
		value, exists := observed[key]
		changed := false
		if exists {
			changed = len(localBase) == 0
			if !changed {
				changed = true
				for _, version := range localBase {
					if !version.Deleted && bytes.Equal(bytes.TrimSpace(version.Value), bytes.TrimSpace(value)) {
						changed = false
						break
					}
				}
			}
		} else {
			for _, version := range localBase {
				if !version.Deleted {
					changed = true
					break
				}
			}
		}
		local := append([]Version(nil), localBase...)
		if changed {
			if counter == 0 {
				return nil, counter, errors.New("device counter is exhausted")
			}
			next, err := Advance(localBase, device, counter, value, !exists)
			if err != nil {
				return nil, counter, err
			}
			local = []Version{next}
			counter++
		}
		versions, err := Merge(local, peers[key])
		if err != nil {
			return nil, counter, fmt.Errorf("merge entity %q: %w", key, err)
		}
		if len(versions) > 0 {
			merged[key] = versions
		}
	}
	return merged, counter, nil
}

func cloneClock(c Clock) Clock {
	out := Clock{}
	for k, v := range c {
		out[k] = v
	}
	return out
}
func validate(v Version) error {
	if len(v.Clock) == 0 {
		return errors.New("version clock is empty")
	}
	for id, n := range v.Clock {
		if id == "" || n == 0 {
			return errors.New("invalid version clock")
		}
	}
	if v.Deleted && len(v.Value) > 0 {
		return errors.New("deleted version must not contain a value")
	}
	if !v.Deleted && !json.Valid(v.Value) {
		return fmt.Errorf("version value must be JSON")
	}
	return nil
}
