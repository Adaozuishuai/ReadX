use axum::routing::{get, post};
use axum::Router;

use crate::app::AppState;
use crate::routes::{accounts, admin_invites, admin_platform, admin_users};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/auth/logout", post(accounts::logout_route))
        .route("/api/v1/auth/password", post(accounts::change_password_route))
        .route(
            "/api/v1/admin/users",
            get(admin_users::list_users_route).post(accounts::create_user_route),
        )
        .route(
            "/api/v1/admin/users/:user_id",
            get(admin_users::user_detail_route).delete(admin_users::delete_user_route),
        )
        .route("/api/v1/admin/users/:user_id/jobs", get(admin_users::user_jobs_route))
        .route("/api/v1/admin/users/:user_id/role", post(admin_users::set_role_route))
        .route("/api/v1/admin/users/:user_id/restore", post(admin_users::restore_user_route))
        .route("/api/v1/admin/users/:user_id/reset-password", post(accounts::reset_password_route))
        .route("/api/v1/admin/users/:user_id/disable", post(accounts::disable_user_route))
        .route("/api/v1/admin/users/:user_id/enable", post(accounts::enable_user_route))
        .route(
            "/api/v1/admin/users/:user_id/pages",
            get(accounts::user_pages_route).post(accounts::grant_pages_route),
        )
        .route("/api/v1/account/pages", get(accounts::my_pages_route))
        .route(
            "/api/v1/admin/invites",
            get(admin_invites::list_invites_route).post(admin_invites::create_invite_route),
        )
        .route("/api/v1/admin/invites/:invite_id", get(admin_invites::invite_detail_route))
        .route("/api/v1/admin/invites/:invite_id/revoke", post(admin_invites::revoke_invite_route))
        .route(
            "/api/v1/admin/platform",
            get(admin_platform::get_platform_route).put(admin_platform::put_platform_route),
        )
        .route("/api/v1/admin/platform/test", post(admin_platform::test_platform_route))
}
