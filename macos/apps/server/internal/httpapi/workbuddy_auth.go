package httpapi

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/securefile"
)

type workBuddyLoginStatus struct {
	State   string `json:"state,omitempty"`
	URL     string `json:"url,omitempty"`
	Pending bool   `json:"pending"`
	Error   string `json:"error,omitempty"`
}

func (s *Server) workBuddyStatus(cfg ai.Config) map[string]any {
	s.workBuddyLoginMu.Lock()
	login := s.workBuddyLogin
	s.workBuddyLoginMu.Unlock()
	return map[string]any{
		"authenticated": strings.TrimSpace(cfg.WorkBuddyAuth.AccessToken) != "",
		"nickname":      cfg.WorkBuddyAuth.Nickname,
		"expiresAt":     cfg.WorkBuddyAuth.ExpiresAt,
		"login":         login,
	}
}

func (s *Server) handleWorkBuddyLogin(w http.ResponseWriter, r *http.Request) {
	login, err := ai.BeginWorkBuddyLogin(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	s.workBuddyLoginMu.Lock()
	if s.workBuddyLogin.Pending {
		s.workBuddyLoginMu.Unlock()
		writeError(w, http.StatusConflict, "WorkBuddy 登录已在等待中")
		return
	}
	s.workBuddyLogin = workBuddyLoginStatus{State: login.State, URL: login.URL, Pending: true}
	s.workBuddyLoginMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"state": login.State, "url": login.URL, "pending": true})
	go s.completeWorkBuddyLogin(login.State)
}

func (s *Server) completeWorkBuddyLogin(state string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute+10*time.Second)
	defer cancel()
	credential, err := ai.WaitWorkBuddyLogin(ctx, state)
	if err == nil {
		configPath := legacy.NewPaths(s.cfg.DataRoot).ConfigFile()
		authPath := filepath.Join(filepath.Dir(configPath), "workbuddy-auth.json")
		err = ai.SaveWorkBuddyCredential(authPath, credential)
		if err == nil {
			err = securefile.RestrictToCurrentUser(filepath.Dir(authPath))
		}
		if err == nil {
			err = securefile.RestrictToCurrentUser(authPath)
		}
	}
	s.workBuddyLoginMu.Lock()
	defer s.workBuddyLoginMu.Unlock()
	if s.workBuddyLogin.State != state {
		return
	}
	s.workBuddyLogin.Pending = false
	if err != nil {
		s.workBuddyLogin.Error = err.Error()
	} else {
		s.workBuddyLogin.Error = ""
	}
}

func (s *Server) handleWorkBuddyLoginStatus(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.aiConfig()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s.workBuddyStatus(cfg))
}

func (s *Server) handleWorkBuddyLogout(w http.ResponseWriter, r *http.Request) {
	configPath := legacy.NewPaths(s.cfg.DataRoot).ConfigFile()
	authPath := filepath.Join(filepath.Dir(configPath), "workbuddy-auth.json")
	if err := ai.DeleteWorkBuddyCredential(authPath); err != nil && !os.IsNotExist(err) {
		writeError(w, http.StatusInternalServerError, "清除 WorkBuddy 登录失败")
		return
	}
	s.workBuddyLoginMu.Lock()
	s.workBuddyLogin = workBuddyLoginStatus{}
	s.workBuddyLoginMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": false})
}
