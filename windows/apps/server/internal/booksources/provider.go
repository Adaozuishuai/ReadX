// Package booksources implements explicit, independently authored book-source adapters.
package booksources

import (
	"context"
	"errors"
	"net/http"
	"net/url"
)

type Capability struct {
	Search       bool `json:"search"`
	Detail       bool `json:"detail"`
	Download     bool `json:"download"`
	RequiresAuth bool `json:"requiresAuth"`
}
type Rights struct {
	Access      string `json:"access"`
	Basis       string `json:"basis,omitempty"`
	CanDownload bool   `json:"canDownload"`
	CanCache    bool   `json:"canCache"`
	CanRead     bool   `json:"canRead"`
	Reason      string `json:"reason,omitempty"`
}

func (r Rights) AllowsDownload() bool {
	return r.Access == "allowed" && r.CanDownload && r.CanCache && r.CanRead
}

type Book struct {
	ID                         string   `json:"id"`
	ProviderID                 string   `json:"providerId"`
	Title                      string   `json:"title"`
	Authors                    []string `json:"authors"`
	ISBN                       string   `json:"isbn,omitempty"`
	Language                   string   `json:"language,omitempty"`
	CoverURL                   string   `json:"coverUrl,omitempty"`
	Description                string   `json:"description,omitempty"`
	Formats                    []string `json:"formats"`
	SourceURL                  string   `json:"sourceUrl,omitempty"`
	Rights                     Rights   `json:"rights"`
	RequiresRightsConfirmation bool     `json:"requiresRightsConfirmation,omitempty"`
}
type Source struct {
	ProviderID   string     `json:"providerId"`
	Name         string     `json:"name"`
	Enabled      bool       `json:"enabled"`
	Capabilities Capability `json:"capabilities"`
	Reason       string     `json:"reason,omitempty"`
}
type SearchResult struct {
	Books      []Book `json:"books"`
	NextCursor string `json:"nextCursor,omitempty"`
}
type Artifact struct {
	FileName    string
	ContentType string
	Data        []byte
	SHA256      string
}
type Progress func(received, total int64)
type Provider interface {
	Info() Source
	Search(context.Context, string, string) (SearchResult, error)
	Detail(context.Context, string) (Book, error)
	Download(context.Context, string, string, Progress) (Artifact, error)
}
type Error struct {
	Code    string `json:"code"`
	Message string `json:"error"`
	Status  int    `json:"-"`
}

func (e *Error) Error() string                    { return e.Message }
func Fail(code, message string, status int) error { return &Error{code, message, status} }
func PublicError(err error) *Error {
	var known *Error
	if errors.As(err, &known) {
		return known
	}
	if errors.Is(err, context.Canceled) {
		return &Error{"CANCELLED", "已取消下载", 409}
	}
	return &Error{"DOWNLOAD_FAILED", "书源请求失败，请重试", http.StatusBadGateway}
}

func DefaultProviders(proxy func(*http.Request) (*url.URL, error)) []Provider {
	return defaultProviders(proxy)
}
