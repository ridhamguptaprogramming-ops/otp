import json
import os
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from flask import Flask, jsonify, request, send_from_directory # type: ignore

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "carejr.db"

OTP_TTL_SECONDS = 180
SESSION_TTL_HOURS = 24 * 7

PHONE_RE = re.compile(r"^\d{10}$")
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
PINCODE_RE = re.compile(r"^\d{6}$")
EMAIL_ACCOUNT_PREFIX = "email:"

app = Flask(__name__, static_folder=None)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def parse_iso(value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value)
    except Exception:
        return None


def get_db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def ensure_columns(db: sqlite3.Connection, table: str, required_columns: Dict[str, str]) -> None:
    existing = {
        str(row["name"])
        for row in db.execute(f"PRAGMA table_info({table})").fetchall()
    }
    for column, column_type in required_columns.items():
        if column not in existing:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {column_type}")


def init_db() -> None:
    with get_db() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                phone TEXT PRIMARY KEY,
                clinic_code TEXT DEFAULT '',
                name TEXT DEFAULT '',
                dob TEXT DEFAULT '',
                gender TEXT DEFAULT '',
                blood_group TEXT DEFAULT '',
                state TEXT DEFAULT '',
                city TEXT DEFAULT '',
                pincode TEXT DEFAULT '',
                address TEXT DEFAULT '',
                contact_phone TEXT DEFAULT '',
                email TEXT DEFAULT '',
                occupation TEXT DEFAULT '',
                emergency_relation TEXT DEFAULT '',
                insurance_id TEXT DEFAULT '',
                emergency_contact TEXT DEFAULT '',
                alternate_phone TEXT DEFAULT '',
                marital_status TEXT DEFAULT '',
                updated_at TEXT NOT NULL
            )
            """
        )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS otps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone TEXT NOT NULL,
                otp TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                used INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                phone TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )
            """
        )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS reports (
                phone TEXT NOT NULL,
                id TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (phone, id)
            )
            """
        )

        ensure_columns(
            db,
            "users",
            {
                "contact_phone": "TEXT DEFAULT ''",
                "email": "TEXT DEFAULT ''",
                "occupation": "TEXT DEFAULT ''",
                "emergency_relation": "TEXT DEFAULT ''",
                "insurance_id": "TEXT DEFAULT ''",
                "emergency_contact": "TEXT DEFAULT ''",
                "alternate_phone": "TEXT DEFAULT ''",
                "marital_status": "TEXT DEFAULT ''",
            },
        )


def cleanup_expired_data() -> None:
    now = isoformat_utc(utc_now())
    with get_db() as db:
        db.execute("DELETE FROM otps WHERE expires_at < ? OR used = 1", (now,))
        db.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))


def json_error(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message}), status


def normalize_email(value: Any) -> str:
    return str(value or "").strip().lower()


def is_allowed_dev_origin(origin: str) -> bool:
    return bool(re.match(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$", origin))


def parse_login_identifier(data: Dict[str, Any]) -> Tuple[Optional[str], Optional[str], str, str]:
    phone = str(data.get("phone", "")).strip()
    email = normalize_email(data.get("email", ""))

    if email:
        if not EMAIL_RE.match(email):
            return None, None, "", "Please enter a valid email address."
        return f"{EMAIL_ACCOUNT_PREFIX}{email}", "email", "", email

    if phone:
        if not PHONE_RE.match(phone):
            return None, None, "", "Enter a valid 10-digit phone number."
        return phone, "phone", phone, ""

    return None, None, "", "Enter a valid 10-digit phone number or email address."


def split_account_identifier(account_id: str) -> Tuple[str, str]:
    account = str(account_id or "").strip()
    if account.startswith(EMAIL_ACCOUNT_PREFIX):
        return "", normalize_email(account[len(EMAIL_ACCOUNT_PREFIX):])
    if PHONE_RE.match(account):
        return account, ""
    return "", ""


def get_bearer_phone() -> Tuple[Optional[str], Optional[str]]:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None, None

    token = header.split(" ", 1)[1].strip()
    if not token:
        return None, None

    with get_db() as db:
        session_row = db.execute(
            "SELECT phone, expires_at FROM sessions WHERE token = ?",
            (token,),
        ).fetchone()

        if not session_row:
            return None, None

        expires_at = parse_iso(session_row["expires_at"])
        if not expires_at or expires_at <= utc_now():
            db.execute("DELETE FROM sessions WHERE token = ?", (token,))
            return None, None

        return str(session_row["phone"]), token


def require_auth() -> Tuple[Optional[str], Optional[str], Optional[Any]]:
    phone, token = get_bearer_phone()
    if not phone:
        return None, None, json_error("Unauthorized", 401)
    return phone, token, None


def normalize_profile_payload(data: Dict[str, Any]) -> Dict[str, str]:
    return {
        "phone": str(data.get("phone", "")).strip(),
        "clinicCode": str(data.get("clinicCode", "")).strip().upper(),
        "name": str(data.get("name", "")).strip(),
        "dob": str(data.get("dob", "")).strip(),
        "gender": str(data.get("gender", "")).strip(),
        "bloodGroup": str(data.get("bloodGroup", "")).strip(),
        "state": str(data.get("state", "")).strip(),
        "city": str(data.get("city", "")).strip(),
        "pincode": str(data.get("pincode", "")).strip(),
        "address": str(data.get("address", "")).strip(),
        "email": str(data.get("email", "")).strip().lower(),
        "occupation": str(data.get("occupation", "")).strip(),
        "emergencyRelation": str(data.get("emergencyRelation", "")).strip(),
        "insuranceId": str(data.get("insuranceId", "")).strip().upper(),
        "alternatePhone": str(data.get("alternatePhone", "")).strip(),
        "maritalStatus": str(data.get("maritalStatus", "")).strip(),
        "emergencyContact": str(data.get("emergencyContact", "")).strip(),
    }


@app.before_request
def _before_request():
    if request.path.startswith("/api/"):
        cleanup_expired_data()


@app.after_request
def _after_request(response):
    origin = str(request.headers.get("Origin", "")).strip()
    if origin and is_allowed_dev_origin(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return response


@app.route("/api/<path:_path>", methods=["OPTIONS"])
def api_options(_path: str):
    return ("", 204)


@app.route("/api/health", methods=["GET"])
def health_check():
    return jsonify({"ok": True, "service": "carejr-python-backend"})


@app.route("/api/send-otp", methods=["POST"])
def send_otp():
    data = request.get_json(silent=True) or {}
    account_id, identifier_type, login_phone, login_email_or_error = parse_login_identifier(data)
    if not account_id or not identifier_type:
        return json_error(login_email_or_error, 400)

    login_email = login_email_or_error
    clinic_code = str(data.get("clinicCode", "")).strip().upper()

    otp = f"{secrets.randbelow(9000) + 1000:04d}"
    now = utc_now()
    expires_at = now + timedelta(seconds=OTP_TTL_SECONDS)

    with get_db() as db:
        db.execute(
            """
            INSERT INTO otps (phone, otp, created_at, expires_at, used)
            VALUES (?, ?, ?, ?, 0)
            """,
            (account_id, otp, isoformat_utc(now), isoformat_utc(expires_at)),
        )
        db.execute(
            """
            INSERT INTO users (phone, clinic_code, contact_phone, email, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(phone) DO UPDATE SET
                clinic_code = excluded.clinic_code,
                contact_phone = CASE
                    WHEN excluded.contact_phone <> '' THEN excluded.contact_phone
                    ELSE users.contact_phone
                END,
                email = CASE
                    WHEN users.email = '' AND excluded.email <> '' THEN excluded.email
                    ELSE users.email
                END,
                updated_at = excluded.updated_at
            """,
            (account_id, clinic_code, login_phone, login_email, isoformat_utc(now)),
        )

    return jsonify(
        {
            "ok": True,
            "message": "OTP sent successfully.",
            "demoOtp": otp,
            "identifierType": identifier_type,
            "cooldownSeconds": 20,
            "expiresInSeconds": OTP_TTL_SECONDS,
        }
    )


@app.route("/api/verify-otp", methods=["POST"])
def verify_otp():
    data = request.get_json(silent=True) or {}
    account_id, identifier_type, login_phone, login_email_or_error = parse_login_identifier(data)
    if not account_id or not identifier_type:
        return json_error(login_email_or_error, 400)

    login_email = login_email_or_error
    otp = str(data.get("otp", "")).strip()

    if not re.match(r"^\d{4}$", otp):
        return json_error("OTP must be a 4-digit number.", 400)

    now = utc_now()
    with get_db() as db:
        otp_row = db.execute(
            """
            SELECT id, expires_at
            FROM otps
            WHERE phone = ? AND otp = ? AND used = 0
            ORDER BY id DESC
            LIMIT 1
            """,
            (account_id, otp),
        ).fetchone()

        if not otp_row:
            return json_error("Invalid OTP. Please try again.", 401)

        expires_at = parse_iso(otp_row["expires_at"])
        if not expires_at or expires_at <= now:
            db.execute("UPDATE otps SET used = 1 WHERE id = ?", (otp_row["id"],))
            return json_error("OTP expired. Please request a new OTP.", 401)

        db.execute("UPDATE otps SET used = 1 WHERE id = ?", (otp_row["id"],))
        token = secrets.token_urlsafe(32)
        session_expires = now + timedelta(hours=SESSION_TTL_HOURS)
        db.execute(
            """
            INSERT INTO sessions (token, phone, created_at, expires_at)
            VALUES (?, ?, ?, ?)
            """,
            (token, account_id, isoformat_utc(now), isoformat_utc(session_expires)),
        )

        user_row = db.execute(
            """
            SELECT contact_phone, email
            FROM users
            WHERE phone = ?
            """,
            (account_id,),
        ).fetchone()

    if user_row:
        login_phone = str(user_row["contact_phone"] or "").strip() or login_phone
        login_email = normalize_email(user_row["email"] or "") or login_email

    return jsonify(
        {
            "ok": True,
            "phone": login_phone,
            "email": login_email,
            "identifierType": identifier_type,
            "sessionToken": token,
            "expiresAt": isoformat_utc(session_expires),
        }
    )


@app.route("/api/logout", methods=["POST"])
def logout():
    _, token = get_bearer_phone()
    if token:
        with get_db() as db:
            db.execute("DELETE FROM sessions WHERE token = ?", (token,))
    return jsonify({"ok": True})


@app.route("/api/profile", methods=["GET"])
def get_profile():
    account_id, _, auth_error = require_auth()
    if auth_error:
        return auth_error

    login_phone, login_email = split_account_identifier(account_id or "")

    with get_db() as db:
        row = db.execute(
            """
            SELECT clinic_code, name, dob, gender, blood_group, state, city,
                   pincode, address, contact_phone, email, occupation, emergency_relation,
                   insurance_id, emergency_contact, alternate_phone, marital_status
            FROM users
            WHERE phone = ?
            """,
            (account_id,),
        ).fetchone()

    if not row:
        return jsonify(
            {
                "ok": True,
                "profile": {
                    "phone": login_phone,
                    "clinicCode": "",
                    "name": "",
                    "dob": "",
                    "gender": "",
                    "bloodGroup": "",
                    "state": "",
                    "city": "",
                    "pincode": "",
                    "address": "",
                    "email": login_email,
                    "loginEmail": login_email,
                    "occupation": "",
                    "emergencyRelation": "",
                    "insuranceId": "",
                    "alternatePhone": "",
                    "maritalStatus": "",
                    "emergencyContact": "",
                },
            }
        )

    return jsonify(
        {
            "ok": True,
            "profile": {
                "phone": (row["contact_phone"] or "").strip() or login_phone,
                "clinicCode": row["clinic_code"] or "",
                "name": row["name"] or "",
                "dob": row["dob"] or "",
                "gender": row["gender"] or "",
                "bloodGroup": row["blood_group"] or "",
                "state": row["state"] or "",
                "city": row["city"] or "",
                "pincode": row["pincode"] or "",
                "address": row["address"] or "",
                "email": (row["email"] or "").strip() or login_email,
                "loginEmail": login_email,
                "occupation": row["occupation"] or "",
                "emergencyRelation": row["emergency_relation"] or "",
                "insuranceId": row["insurance_id"] or "",
                "alternatePhone": row["alternate_phone"] or "",
                "maritalStatus": row["marital_status"] or "",
                "emergencyContact": row["emergency_contact"] or "",
            },
        }
    )


@app.route("/api/profile", methods=["POST"])
def save_profile():
    account_id, _, auth_error = require_auth()
    if auth_error:
        return auth_error

    login_phone, login_email = split_account_identifier(account_id or "")
    payload = normalize_profile_payload(request.get_json(silent=True) or {})

    if payload["phone"] and not PHONE_RE.match(payload["phone"]):
        return json_error("Phone must be a valid 10-digit number.", 400)
    if not payload["phone"] and login_phone:
        payload["phone"] = login_phone

    if payload["name"] and len(payload["name"]) < 2:
        return json_error("Name is too short.", 400)
    if payload["pincode"] and not PINCODE_RE.match(payload["pincode"]):
        return json_error("Pincode must be a valid 6-digit number.", 400)
    if payload["email"] and not EMAIL_RE.match(payload["email"]):
        return json_error("Please enter a valid email address.", 400)
    if payload["occupation"] and len(payload["occupation"]) > 60:
        return json_error("Occupation is too long.", 400)
    if payload["emergencyRelation"] and not re.match(r"^[a-zA-Z\s]{2,30}$", payload["emergencyRelation"]):
        return json_error("Emergency relation should contain letters only.", 400)
    if not payload["email"] and login_email:
        payload["email"] = login_email
    if payload["emergencyContact"] and not PHONE_RE.match(payload["emergencyContact"]):
        return json_error("Emergency contact must be a valid 10-digit number.", 400)
    if payload["alternatePhone"] and not PHONE_RE.match(payload["alternatePhone"]):
        return json_error("Alternate phone must be a valid 10-digit number.", 400)
    if payload["alternatePhone"] and payload["alternatePhone"] == payload["phone"]:
        return json_error("Alternate phone should be different from login phone.", 400)
    if payload["alternatePhone"] and payload["alternatePhone"] == payload["emergencyContact"]:
        return json_error("Alternate phone should be different from emergency contact.", 400)
    if payload["maritalStatus"] and payload["maritalStatus"] not in {"Single", "Married", "Divorced", "Widowed"}:
        return json_error("Please select a valid marital status.", 400)

    with get_db() as db:
        db.execute(
            """
            INSERT INTO users (
                phone, clinic_code, name, dob, gender, blood_group,
                state, city, pincode, address, contact_phone, email, occupation, emergency_relation,
                insurance_id, alternate_phone, marital_status, emergency_contact, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(phone) DO UPDATE SET
                clinic_code = excluded.clinic_code,
                name = excluded.name,
                dob = excluded.dob,
                gender = excluded.gender,
                blood_group = excluded.blood_group,
                state = excluded.state,
                city = excluded.city,
                pincode = excluded.pincode,
                address = excluded.address,
                contact_phone = excluded.contact_phone,
                email = excluded.email,
                occupation = excluded.occupation,
                emergency_relation = excluded.emergency_relation,
                insurance_id = excluded.insurance_id,
                alternate_phone = excluded.alternate_phone,
                marital_status = excluded.marital_status,
                emergency_contact = excluded.emergency_contact,
                updated_at = excluded.updated_at
            """,
            (
                account_id,
                payload["clinicCode"],
                payload["name"],
                payload["dob"],
                payload["gender"],
                payload["bloodGroup"],
                payload["state"],
                payload["city"],
                payload["pincode"],
                payload["address"],
                payload["phone"],
                payload["email"],
                payload["occupation"],
                payload["emergencyRelation"],
                payload["insuranceId"],
                payload["alternatePhone"],
                payload["maritalStatus"],
                payload["emergencyContact"],
                isoformat_utc(utc_now()),
            ),
        )

    return jsonify({"ok": True})


@app.route("/api/reports", methods=["GET"])
def list_reports():
    phone, _, auth_error = require_auth()
    if auth_error:
        return auth_error

    with get_db() as db:
        rows = db.execute(
            """
            SELECT payload
            FROM reports
            WHERE phone = ?
            ORDER BY created_at DESC, updated_at DESC
            """,
            (phone,),
        ).fetchall()

    reports = []
    for row in rows:
        try:
            reports.append(json.loads(row["payload"]))
        except Exception:
            continue

    return jsonify({"ok": True, "reports": reports})


@app.route("/api/stats", methods=["GET"])
def report_stats():
    phone, _, auth_error = require_auth()
    if auth_error:
        return auth_error

    with get_db() as db:
        rows = db.execute(
            """
            SELECT payload
            FROM reports
            WHERE phone = ?
            """,
            (phone,),
        ).fetchall()

    reports = []
    for row in rows:
        try:
            reports.append(json.loads(row["payload"]))
        except Exception:
            continue

    today = utc_now().date().isoformat()

    def risk_value(report: Dict[str, Any]) -> float:
        try:
            return float(report.get("risk", 0) or 0)
        except Exception:
            return 0.0

    def pain_value(report: Dict[str, Any]) -> float:
        try:
            return float(report.get("painScore", "") or 0)
        except Exception:
            return 0.0

    def normalize_priority(value: Any) -> str:
        priority = str(value or "").strip()
        if priority in {"Routine", "Urgent", "Emergency"}:
            return priority
        return "Routine"

    def priority_weight(value: Any) -> int:
        return {"Routine": 1, "Urgent": 2, "Emergency": 3}.get(normalize_priority(value), 1)

    def triage_value(report: Dict[str, Any]) -> str:
        return normalize_priority(report.get("triageRecommendation") or report.get("priority", "Routine"))

    def has_priority_mismatch(report: Dict[str, Any]) -> bool:
        return priority_weight(report.get("priority", "Routine")) < priority_weight(triage_value(report))

    total = len(reports)
    high_risk = sum(1 for report in reports if risk_value(report) >= 70)
    critical = sum(1 for report in reports if risk_value(report) >= 80)
    routine = sum(1 for report in reports if normalize_priority(report.get("priority", "Routine")) == "Routine")
    urgent = sum(1 for report in reports if normalize_priority(report.get("priority", "Routine")) == "Urgent")
    emergency = sum(1 for report in reports if normalize_priority(report.get("priority", "Routine")) == "Emergency")
    triage_emergency = sum(
        1
        for report in reports
        if triage_value(report) == "Emergency"
    )
    triage_needs_attention = sum(
        1
        for report in reports
        if triage_value(report) in {"Urgent", "Emergency"}
    )
    follow_up_due = sum(
        1 for report in reports if str(report.get("followUpDate", "")).strip() and str(report.get("followUpDate")) <= today
    )
    follow_up_today = sum(1 for report in reports if str(report.get("followUpDate", "")).strip() == today)
    follow_up_overdue = sum(1 for report in reports if str(report.get("followUpDate", "")).strip() and str(report.get("followUpDate")) < today)
    follow_up_scheduled = sum(1 for report in reports if str(report.get("followUpDate", "")).strip() and str(report.get("followUpDate")) > today)
    no_follow_up = sum(1 for report in reports if not str(report.get("followUpDate", "")).strip())
    priority_mismatch = sum(1 for report in reports if has_priority_mismatch(report))
    admitted_cases = sum(
        1
        for report in reports
        if str(report.get("admissionStatus", "Not Admitted")).strip() in {"Observation", "Admitted", "ICU"}
    )
    icu_cases = sum(
        1
        for report in reports
        if str(report.get("admissionStatus", "Not Admitted")).strip() == "ICU"
    )
    comorbidity_cases = sum(
        1
        for report in reports
        if str(report.get("comorbidities", "")).strip() != ""
    )
    high_pain_cases = sum(
        1
        for report in reports
        if str(report.get("painScore", "")).strip() != "" and 7 <= pain_value(report) <= 10
    )
    tele_consult_cases = sum(
        1
        for report in reports
        if str(report.get("consultationType", "In-person")).strip() == "Tele-consult"
    )
    icu_transfer_cases = sum(
        1
        for report in reports
        if str(report.get("disposition", "Home Care")).strip() == "ICU Transfer"
    )
    pain_samples = [
        pain_value(report)
        for report in reports
        if str(report.get("painScore", "")).strip() != "" and 0 <= pain_value(report) <= 10
    ]
    average_pain = round(sum(pain_samples) / len(pain_samples), 1) if pain_samples else 0
    average_risk = round(sum(risk_value(report) for report in reports) / total) if total > 0 else 0

    return jsonify(
        {
            "ok": True,
            "stats": {
                "total": total,
                "highRisk": high_risk,
                "critical": critical,
                "routine": routine,
                "urgent": urgent,
                "emergency": emergency,
                "triageEmergency": triage_emergency,
                "triageNeedsAttention": triage_needs_attention,
                "followUpDue": follow_up_due,
                "followUpToday": follow_up_today,
                "followUpOverdue": follow_up_overdue,
                "followUpScheduled": follow_up_scheduled,
                "noFollowUp": no_follow_up,
                "admittedCases": admitted_cases,
                "icuCases": icu_cases,
                "comorbidityCases": comorbidity_cases,
                "highPainCases": high_pain_cases,
                "teleConsultCases": tele_consult_cases,
                "icuTransferCases": icu_transfer_cases,
                "priorityMismatch": priority_mismatch,
                "averagePain": average_pain,
                "averageRisk": average_risk,
            },
        }
    )


@app.route("/api/reports", methods=["POST"])
def upsert_report():
    phone, _, auth_error = require_auth()
    if auth_error:
        return auth_error

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return json_error("Invalid report payload.", 400)

    report_id = str(data.get("id", "")).strip()
    if not report_id:
        report_id = f"report-{int(datetime.now().timestamp() * 1000)}-{secrets.randbelow(1000)}"
        data["id"] = report_id

    now = isoformat_utc(utc_now())
    data.setdefault("createdAt", now)
    payload = json.dumps(data, ensure_ascii=True)

    with get_db() as db:
        existing = db.execute(
            "SELECT created_at FROM reports WHERE phone = ? AND id = ?",
            (phone, report_id),
        ).fetchone()
        created_at = existing["created_at"] if existing else now

        db.execute(
            """
            INSERT INTO reports (phone, id, payload, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(phone, id) DO UPDATE SET
                payload = excluded.payload,
                updated_at = excluded.updated_at
            """,
            (phone, report_id, payload, created_at, now),
        )

    return jsonify({"ok": True, "report": data})


@app.route("/api/reports", methods=["DELETE"])
def clear_reports():
    phone, _, auth_error = require_auth()
    if auth_error:
        return auth_error

    with get_db() as db:
        result = db.execute("DELETE FROM reports WHERE phone = ?", (phone,))

    return jsonify({"ok": True, "deleted": result.rowcount})


@app.route("/api/reports/<report_id>", methods=["DELETE"])
def delete_report(report_id: str):
    phone, _, auth_error = require_auth()
    if auth_error:
        return auth_error

    with get_db() as db:
        result = db.execute(
            "DELETE FROM reports WHERE phone = ? AND id = ?",
            (phone, report_id),
        )

    if result.rowcount == 0:
        return json_error("Report not found.", 404)

    return jsonify({"ok": True})


@app.route("/", defaults={"path": "login.html"})
@app.route("/<path:path>")
def serve_frontend(path: str):
    if path.startswith("api/"):
        return json_error("Not found.", 404)

    file_path = (BASE_DIR / path).resolve()
    if not str(file_path).startswith(str(BASE_DIR)) or not file_path.is_file():
        return json_error("Not found.", 404)

    return send_from_directory(BASE_DIR, path)


if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
