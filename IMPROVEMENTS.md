# CareJR AI Screening - UI and Feature Improvements (v13)

## Updated Files
- `app.py`
- `requirements.txt`
- `login.html`
- `details.html`
- `dashboard.html`
- `newdata.html`
- `previous.html`
- `script.js`
- `styles.css`

## v13 Additional Improvements (Current Update)
### OTP flow hardening
- Server-side OTP resend cooldown is now enforced (`429` with retry seconds).
- Verification now accepts only the latest active OTP for the account.
- Demo OTP is returned only when `CAREJR_EXPOSE_DEMO_OTP=1` is set.
- API responses now include extra security headers for API routes.

### Login UX and reliability
- Added OTP expiry helper text with live countdown.
- Added button busy states during OTP send/verify to prevent duplicate requests.
- Added clearer helper text for clinic code and phone/email login options.

### Additional dashboard/report counts
- Dashboard now includes:
  - `Priority Aligned`
  - `Not Overdue Follow-up`
- Previous reports summary now includes:
  - `Priority Aligned`
  - `Not Overdue`
- Added `Export Visible` in previous reports to export currently filtered results.

## 1. Login UI Improvements
### Added new field
- **Clinic / Facility Code** (`clinicCode`) in login.
- **Email Login** (`emailLogin`) in login.
- Phone input is optional when email is used.

### Logic updates
- Clinic code is sanitized and stored in localStorage.
- Clinic code is shown later on dashboard profile summary.
- OTP send/verify now supports **phone or email** through Python backend APIs.
- Login identifier type is tracked during OTP flow for safer verify/resend behavior.

## 2. Profile Page Improvements (`details.html`)
### Added new fields
- **Gender** (`gender`)
- **City** (`city`)
- **Pincode** (`pincode`)
- **Address** (`address`)
- **Email** (`email`)
- **Occupation** (`occupation`)
- **Emergency Relation** (`emergencyRelation`)
- **Insurance ID** (`insuranceId`)
- **Alternate Phone** (`alternatePhone`)
- **Marital Status** (`maritalStatus`)
- **Blood Group** (`bloodGroup`)
- **Emergency Contact** (`emergencyContact`)

### Logic updates
- Added validation for all new required fields.
- Emergency contact is validated as a 10-digit number.
- Emergency contact cannot match login phone number.
- Alternate phone (optional) is validated as a 10-digit number and cannot duplicate login/emergency contact.
- All new profile fields are persisted and restored.

## 3. Dashboard UI Enhancements (`dashboard.html`)
### Expanded profile section
- Added display values for:
  - Gender
  - Blood Group
  - City
  - Emergency Contact
  - Clinic Code

### Added additional counters
- Routine cases
- Urgent cases
- Emergency cases
- Reports Today
- Follow-up Due
- Follow-up Today
- Follow-up Overdue
- Follow-up Scheduled
- No Follow-up Plan
- AI Needs Attention
- AI Emergency Flag
- Priority Mismatch (selected priority lower than AI triage)
- Admitted / Observed
- High Pain Cases
- Tele-consults
- ICU Transfers
- Average Pain
- Existing risk counters retained and updated.

### Metric logic
- Dashboard counters now include risk + priority distribution.

## 4. New Data Form Enhancements (`newdata.html`)
### Added many new fields
- Patient Age (auto-filled from DOB)
- Consultation Type
- Chief Complaint
- Complaint Duration
- Pain Location
- Known Allergies
- Medication Adherence
- Comorbidities
- Pain Score
- Oxygen Support
- Admission Status
- Disposition
- Vitals:
  - Temperature
  - SpO2
  - Weight
  - Height
  - BMI (auto-calculated)
  - Pulse Rate
  - Respiratory Rate
  - Blood Sugar
  - BP Systolic
  - BP Diastolic
- Provisional Diagnosis
- Care Plan / Advice
- AI Triage Recommendation

### Validation and behavior updates
- Follow-up date must be on/after visit date.
- BP values require both systolic and diastolic together.
- SpO2 range validation (50-100).
- Auto-filled patient name and age from stored profile.

### Report updates
- New fields included in:
  - Draft save/restore
  - Report preview
  - Stored report data
  - Downloaded report text
  - Previous report cards

## 5. Previous Reports Enhancements (`previous.html`)
### Added new controls
- **Priority filter** (`priorityFilter`): All / Routine / Urgent / Emergency
- Additional sort option: **Sort by Priority**
- Added triage filter with routine/urgent/emergency options.
- Added admission filter with not-admitted/observation/admitted/ICU options.
- Added consultation filter (all / in-person / tele-consult / home visit).
- Added follow-up filter (`followUpFilter`) with due/overdue/scheduled/not-set options.
- Added priority mismatch toggle (`priorityMismatchOnly`) to isolate mismatch cases.

### Added new summary counters
- Emergency priority count (`summaryEmergency`)
- Urgent priority count (`summaryUrgent`)
- Routine priority count (`summaryRoutine`)
- Follow-up due count (`summaryFollowUpDue`)
- Follow-up overdue count (`summaryFollowUpOverdue`)
- Follow-up scheduled count (`summaryFollowUpScheduled`)
- No follow-up count (`summaryNoFollowUp`)
- AI needs-attention count (`summaryNeedsAttention`)
- Priority mismatch count (`summaryPriorityMismatch`)
- ICU cases (`summaryICU`)
- High pain count (`summaryHighPain`)
- ICU transfer count (`summaryIcuTransfer`)
- Comorbidity cases (`summaryComorbidity`)
- Average pain (`summaryAveragePain`)
- Existing visible/stored/critical/average counters retained.

### Listing improvements
- Each report card now shows complaint, allergies, vitals, diagnosis, and care plan.
- Added follow-up status badges (Overdue/Due Today/Scheduled/Not Set).
- Added priority match badge showing aligned vs AI-priority mismatch.

## 6. JavaScript Architecture Updates (`script.js`)
### New storage keys
- `CLINIC_CODE`
- `GENDER`
- `BLOOD_GROUP`
- `CITY`
- `EMERGENCY_CONTACT`
- `ALTERNATE_PHONE`
- `MARITAL_STATUS`

### Added/updated logic areas
- Input normalization for clinic code and emergency contact.
- Age calculation utility from DOB.
- Profile hydration extended for all new fields.
- AI analysis source now includes chief complaint and allergy text.
- AI triage engine added using risk + vitals.
- Filter/search/sort logic expanded for new fields and priority mode.
- Dashboard stats expanded with priority + triage counts.
- Draft/preview/download/report cards now include complaint duration, pain location, and medication adherence.
- Local data now syncs with Python backend APIs.

## 7. Python Backend (`app.py`)
### Added backend APIs
- `POST /api/send-otp`
- `POST /api/verify-otp`
- `POST /api/logout`
- `GET /api/profile`
- `POST /api/profile`
- `GET /api/reports`
- `GET /api/stats`
- `POST /api/reports`
- `DELETE /api/reports`
- `DELETE /api/reports/<id>`

### Storage
- SQLite database (`carejr.db`) with tables for users, OTP, sessions, and reports.
- Users table now stores email, insurance id, occupation, emergency relation, and separate contact phone.
- Users table now also stores alternate phone and marital status.
- OTP/session identity now supports either a phone account or an email account.
- Session-based authentication with bearer token.
- `/api/stats` now also returns follow-up overdue, admitted cases, and average pain.
- `/api/stats` now also returns ICU cases and comorbidity cases.
- `/api/stats` now also returns high pain cases, tele-consult cases, and ICU transfer cases.

### Run
1. `python3 -m pip install -r requirements.txt`
2. `python3 app.py`
3. Open `http://localhost:5000`

## 8. Styling Improvements (`styles.css`)
### Added layout support for new UI sections
- `.profile-grid`
- `.tri-grid`
- readonly input style improvements

### Responsive updates
- New grid sections collapse correctly on smaller screens.
- Dashboard profile grid and multi-field forms remain usable on mobile.

## Result
The application now has richer clinical data capture, improved profile completeness, expanded dashboard intelligence, and stronger report filtering/sorting with additional controls and counters.
