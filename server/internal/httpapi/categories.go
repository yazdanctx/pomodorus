package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/yazdanctx/pomodorus/server/internal/profanity"
	"github.com/yazdanctx/pomodorus/server/internal/store/db"
)

// What the picker's field allows, restated in the database as a CHECK.
const (
	categoryNameMin = 1
	categoryNameMax = 40
)

// category is the shape the client reads. The tombstone never crosses the
// wire: a deleted category is simply not in the list.
type category struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	IsPublic bool   `json:"isPublic"`
}

type categoriesResponse struct {
	Categories []category `json:"categories"`
	ServerNow  int64      `json:"serverNow"`
}

type categoryResponse struct {
	Category  category `json:"category"`
	ServerNow int64    `json:"serverNow"`
}

func asCategory(row db.Category) category {
	return category{
		ID:       uuid.UUID(row.ID.Bytes).String(),
		Name:     row.Name,
		IsPublic: row.IsPublic,
	}
}

func (s *Server) listCategories(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	rows, err := s.q.LiveCategories(ctx, user.ID)
	if err != nil {
		s.log.Error("list categories", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	// An empty list is an empty array, never null: the picker opens straight
	// into its create form when there is nothing yet, and it should not have
	// to tell the two apart.
	out := make([]category, 0, len(rows))
	for _, row := range rows {
		out = append(out, asCategory(row))
	}
	writeJSON(w, http.StatusOK, categoriesResponse{Categories: out, ServerNow: s.now().UnixMilli()})
}

type createCategoryRequest struct {
	// Minted by the client, so a retry lands on the row the first attempt
	// created instead of making a second one.
	ID       string `json:"id"`
	Name     string `json:"name"`
	IsPublic bool   `json:"isPublic"`
}

func (s *Server) createCategory(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	var body createCategoryRequest
	if err := readJSON(r, &body); err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	id, err := uuid.Parse(strings.TrimSpace(body.ID))
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	name, failure := checkCategoryName(body.Name, body.IsPublic)
	if failure != "" {
		s.writeError(w, http.StatusBadRequest, failure)
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	now := s.now()
	row, err := s.q.CreateCategory(ctx, db.CreateCategoryParams{
		ID:        pgID(id),
		UserID:    user.ID,
		Name:      name,
		IsPublic:  body.IsPublic,
		CreatedAt: pgTime(now),
	})
	if err != nil {
		s.log.Error("create category", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	// A retry returns the row the first attempt made, which may belong to
	// somebody else if a client minted a colliding id. Answering with another
	// user's row would be the leak; answering "not yours" is the truth.
	if row.UserID != user.ID {
		s.writeError(w, http.StatusConflict, "category_not_found")
		return
	}

	writeJSON(w, http.StatusOK, categoryResponse{Category: asCategory(row), ServerNow: now.UnixMilli()})
}

type updateCategoryRequest struct {
	Name     string `json:"name"`
	IsPublic bool   `json:"isPublic"`
}

func (s *Server) updateCategory(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		s.writeError(w, http.StatusNotFound, "category_not_found")
		return
	}

	var body updateCategoryRequest
	if err := readJSON(r, &body); err != nil {
		s.writeError(w, http.StatusBadRequest, "malformed_request")
		return
	}

	name, failure := checkCategoryName(body.Name, body.IsPublic)
	if failure != "" {
		s.writeError(w, http.StatusBadRequest, failure)
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	now := s.now()
	row, err := s.q.UpdateCategory(ctx, db.UpdateCategoryParams{
		ID:        pgID(id),
		UserID:    user.ID,
		Name:      name,
		IsPublic:  body.IsPublic,
		UpdatedAt: pgTime(now),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		s.writeError(w, http.StatusNotFound, "category_not_found")
		return
	}
	if err != nil {
		s.log.Error("update category", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	writeJSON(w, http.StatusOK, categoryResponse{Category: asCategory(row), ServerNow: now.UnixMilli()})
}

func (s *Server) deleteCategory(w http.ResponseWriter, r *http.Request) {
	user, ok := s.currentUser(r)
	if !ok {
		s.writeError(w, http.StatusUnauthorized, "not_signed_in")
		return
	}

	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		s.writeError(w, http.StatusNotFound, "category_not_found")
		return
	}

	ctx, cancel := timeout(r, 5*time.Second)
	defer cancel()

	// A tombstone rather than a delete: the row keeps its name and every
	// session recorded against it keeps pointing at it, so a tidy-up never
	// costs somebody their history.
	if _, err := s.q.DeleteCategory(ctx, db.DeleteCategoryParams{
		ID: pgID(id), UserID: user.ID, DeletedAt: pgTime(s.now()),
	}); err != nil {
		s.log.Error("delete category", "error", err)
		s.writeError(w, http.StatusInternalServerError, "server_error")
		return
	}

	// Deleting one that was already deleted is not a failure: the caller asked
	// for a state and the state is what it gets.
	w.WriteHeader(http.StatusNoContent)
}

// checkCategoryName trims and vets a name, returning the error code to answer
// with, or "" when the name is fine.
//
// Profanity is checked only when the name is public. A private category's name
// never leaves its owner, and refusing a word only they will ever read would
// be moralising at somebody about their own notes.
func checkCategoryName(raw string, isPublic bool) (name, failure string) {
	name = strings.TrimSpace(raw)
	if length := utf8.RuneCountInString(name); length < categoryNameMin || length > categoryNameMax {
		return "", "category_name_length"
	}
	if isPublic && profanity.Contains(name) {
		return "", "category_name_profane"
	}
	return name, ""
}

func pgID(id uuid.UUID) pgtype.UUID {
	return pgtype.UUID{Bytes: id, Valid: true}
}

func pgTime(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t, Valid: true}
}
