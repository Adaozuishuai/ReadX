package syncmerge

import (
	"encoding/json"
	"testing"
)

func value(clock Clock, text string) Version {
	return Version{Clock: clock, Value: json.RawMessage(`"` + text + `"`)}
}
func TestConcurrentEditsArePreservedAndResolutionDominates(t *testing.T) {
	base := value(Clock{"a": 1}, "original")
	a, err := Advance([]Version{base}, "a", 2, json.RawMessage(`"edit-a"`), false)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Advance([]Version{base}, "b", 1, json.RawMessage(`"edit-b"`), false)
	if err != nil {
		t.Fatal(err)
	}
	merged, err := Merge([]Version{base, a}, []Version{b})
	if err != nil || len(merged) != 2 {
		t.Fatalf("concurrent edits lost: %+v %v", merged, err)
	}
	resolved, err := Advance(merged, "a", 3, json.RawMessage(`"resolved"`), false)
	if err != nil {
		t.Fatal(err)
	}
	merged, err = Merge(merged, []Version{resolved})
	if err != nil || len(merged) != 1 || string(merged[0].Value) != `"resolved"` {
		t.Fatalf("resolution failed: %+v %v", merged, err)
	}
}
func TestDeleteAndEditConflictDoesNotResurrectSilently(t *testing.T) {
	base := value(Clock{"a": 1}, "original")
	deletion, err := Advance([]Version{base}, "a", 2, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	edit, err := Advance([]Version{base}, "b", 1, json.RawMessage(`"new"`), false)
	if err != nil {
		t.Fatal(err)
	}
	versions, err := Merge([]Version{base, deletion}, []Version{edit})
	if err != nil || len(versions) != 2 {
		t.Fatalf("delete conflict lost: %+v %v", versions, err)
	}
	deleted, err := Advance(versions, "b", 2, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	versions, err = Merge(versions, []Version{deleted})
	if err != nil || len(versions) != 1 || !versions[0].Deleted {
		t.Fatalf("delete resolution failed: %+v %v", versions, err)
	}
}
func TestIdempotenceAndInvalidCollisions(t *testing.T) {
	first := value(Clock{"a": 1}, "one")
	versions, err := Merge([]Version{first}, []Version{first})
	if err != nil || len(versions) != 1 {
		t.Fatal(versions, err)
	}
	if _, err = Merge([]Version{first}, []Version{value(Clock{"a": 1}, "other")}); err == nil {
		t.Fatal("same clock with different content accepted")
	}
	if _, err = Advance([]Version{first}, "a", 1, json.RawMessage(`"x"`), false); err == nil {
		t.Fatal("reused counter accepted")
	}
}
