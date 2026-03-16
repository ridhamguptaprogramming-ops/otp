const STORAGE_KEYS = {
  PHONE: "phone",
  LOGIN_EMAIL: "loginEmail",
  SESSION_TOKEN: "sessionToken",
  GENERATED_OTP: "generatedOtp",
  OTP_SENT_AT: "otpSentAt",
  OTP_IDENTIFIER: "otpIdentifier",
  OTP_IDENTIFIER_TYPE: "otpIdentifierType",
  CLINIC_CODE: "clinicCode",
  NAME: "name",
  DOB: "dob",
  GENDER: "gender",
  BLOOD_GROUP: "bloodGroup",
  STATE: "state",
  CITY: "city",
  PINCODE: "pincode",
  ADDRESS: "address",
  EMAIL: "email",
  OCCUPATION: "occupation",
  EMERGENCY_RELATION: "emergencyRelation",
  INSURANCE_ID: "insuranceId",
  ALTERNATE_PHONE: "alternatePhone",
  MARITAL_STATUS: "maritalStatus",
  EMERGENCY_CONTACT: "emergencyContact",
  CURRENT_REPORT: "currentReport",
  REPORTS: "reports",
  DRAFT_REPORT: "draftReport"
};

let generatedOtp = null;
let recognition = null;
let fullTranscript = "";
let cameraStream = null;
let breathInterval = null;
let pulseInterval = null;
let monitoringActive = false;
let otpCooldownInterval = null;
let otpExpiryInterval = null;
const API_BASE_URL = (() => {
  const isLocalHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  if (isLocalHost && window.location.port && window.location.port !== "5000") {
    return "http://localhost:5000/api";
  }
  return "/api";
})();
const PHONE_PATTERN = /^\d{10}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_COOLDOWN_SECONDS = 20;

function byId(id) {
  return document.getElementById(id);
}

function safeText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseJSON(value, fallback) {
  try {
    if (!value) {
      return fallback;
    }
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function getStoredJSON(key, fallback) {
  return parseJSON(localStorage.getItem(key), fallback);
}

function setStoredJSON(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}

function getSessionToken() {
  return localStorage.getItem(STORAGE_KEYS.SESSION_TOKEN) || "";
}

async function apiRequest(path, options = {}) {
  const {
    method = "GET",
    body,
    headers = {},
    skipAuth = false
  } = options;

  const requestHeaders = { ...headers };
  if (body !== undefined && !requestHeaders["Content-Type"]) {
    requestHeaders["Content-Type"] = "application/json";
  }

  if (!skipAuth) {
    const token = getSessionToken();
    if (token) {
      requestHeaders.Authorization = `Bearer ${token}`;
    }
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: requestHeaders,
      body
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        data = { message: text };
      }
    }

    if (!response.ok) {
      if (!skipAuth && response.status === 401) {
        localStorage.removeItem(STORAGE_KEYS.SESSION_TOKEN);
        if (!isLoginPage()) {
          window.location.href = "login.html";
        }
      }
      return {
        ok: false,
        status: response.status,
        data,
        message:
          (data && (data.error || data.message)) ||
          (response.status === 405
            ? "Request failed (405). Start Python backend and open http://localhost:5000/login.html"
            : `Request failed (${response.status})`)
      };
    }

    return {
      ok: true,
      status: response.status,
      data: data || {}
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: "Unable to reach Python backend. Start server and retry."
    };
  }
}

function showMessage(elementId, message, type = "success") {
  const el = byId(elementId);
  if (!el) {
    if (message) {
      alert(message);
    }
    return;
  }

  el.textContent = message || "";
  el.className = "inline-message";
  if (message) {
    el.classList.add(type === "error" ? "error-message" : "success-message");
  }
}

function setButtonBusy(button, busy, busyLabel = "Please wait...") {
  if (!button) {
    return;
  }

  if (busy) {
    if (!button.dataset.originalLabel) {
      button.dataset.originalLabel = button.textContent || "";
    }
    button.disabled = true;
    button.classList.add("is-busy");
    button.textContent = busyLabel;
    return;
  }

  button.disabled = false;
  button.classList.remove("is-busy");
  if (button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
    delete button.dataset.originalLabel;
  }
}

function resetOtpMeta(defaultMessage = "OTP will be valid for a limited time.") {
  const otpMeta = byId("otpMeta");
  if (!otpMeta) {
    return;
  }

  otpMeta.textContent = defaultMessage;
  otpMeta.classList.remove("otp-expiring", "otp-expired");
}

function startOtpExpiryCountdown(totalSeconds = 180) {
  const otpMeta = byId("otpMeta");
  if (!otpMeta) {
    return;
  }

  clearInterval(otpExpiryInterval);
  let seconds = Math.max(0, Number(totalSeconds) || 0);

  const update = () => {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    otpMeta.textContent = `OTP expires in ${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    otpMeta.classList.toggle("otp-expiring", seconds <= 30 && seconds > 0);
    otpMeta.classList.remove("otp-expired");
  };

  update();
  otpExpiryInterval = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(otpExpiryInterval);
      otpExpiryInterval = null;
      otpMeta.textContent = "OTP expired. Request a new OTP.";
      otpMeta.classList.remove("otp-expiring");
      otpMeta.classList.add("otp-expired");
      return;
    }
    update();
  }, 1000);
}

function getReportField(report, keys, fallback = "N/A") {
  for (let i = 0; i < keys.length; i += 1) {
    const value = report[keys[i]];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return fallback;
}

function normalizePhoneInput(event) {
  const input = event.target;
  input.value = input.value.replace(/\D/g, "").slice(0, 10);
}

function normalizeTextInput(event) {
  const input = event.target;
  input.value = input.value.replace(/[^\w\s-]/g, "").toUpperCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveOtpIdentifier() {
  const phoneInput = byId("phone");
  const emailInput = byId("emailLogin");
  const phone = phoneInput ? phoneInput.value.trim() : "";
  const email = normalizeEmail(emailInput ? emailInput.value : "");

  if (email) {
    if (!EMAIL_PATTERN.test(email)) {
      return { error: "Please enter a valid email address.", focus: emailInput };
    }
    return { type: "email", phone: "", email };
  }

  if (!PHONE_PATTERN.test(phone)) {
    return { error: "Enter a valid 10-digit phone number or use email.", focus: phoneInput };
  }

  return { type: "phone", phone, email: "" };
}

function calculateAgeFromDOB(dobValue) {
  if (!dobValue) {
    return "";
  }

  const dobDate = new Date(dobValue);
  if (Number.isNaN(dobDate.getTime())) {
    return "";
  }

  const today = new Date();
  let age = today.getFullYear() - dobDate.getFullYear();
  const monthDiff = today.getMonth() - dobDate.getMonth();
  const dayDiff = today.getDate() - dobDate.getDate();

  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age -= 1;
  }

  return age >= 0 ? String(age) : "";
}

function calculateBMI(weightKg, heightCm) {
  const weight = Number(weightKg);
  const height = Number(heightCm);

  if (!weight || !height || weight <= 0 || height <= 0) {
    return "";
  }

  const heightM = height / 100;
  const bmi = weight / (heightM * heightM);
  if (!Number.isFinite(bmi)) {
    return "";
  }

  return bmi.toFixed(1);
}

function updateBMIField() {
  const weightInput = byId("weight");
  const heightInput = byId("height");
  const bmiInput = byId("bmi");

  if (!weightInput || !heightInput || !bmiInput) {
    return;
  }

  bmiInput.value = calculateBMI(weightInput.value, heightInput.value);
}

function recommendTriageLevel(data) {
  const risk = Number(data.risk) || 0;
  const spo2 = Number(data.spo2) || 0;
  const pulseRate = Number(data.pulseRate) || 0;
  const respRate = Number(data.respRate) || 0;
  const bpSystolic = Number(data.bpSystolic) || 0;
  const temperature = Number(data.temperature) || 0;
  const bloodSugar = Number(data.bloodSugar) || 0;
  const painScore = Number(data.painScore) || 0;
  const oxygenSupport = String(data.oxygenSupport || "").trim();

  if (
    risk >= 80 ||
    (spo2 > 0 && spo2 < 92) ||
    oxygenSupport === "Ventilator" ||
    oxygenSupport === "NIV" ||
    bpSystolic >= 180 ||
    painScore >= 9 ||
    (pulseRate > 0 && (pulseRate >= 130 || pulseRate < 40)) ||
    (respRate > 0 && (respRate >= 30 || respRate < 8))
  ) {
    return "Emergency";
  }

  if (
    risk >= 60 ||
    (temperature > 0 && temperature >= 101) ||
    (spo2 > 0 && spo2 < 95) ||
    oxygenSupport === "Oxygen" ||
    bpSystolic >= 160 ||
    painScore >= 7 ||
    (bloodSugar > 0 && (bloodSugar >= 250 || bloodSugar < 70)) ||
    (pulseRate > 0 && pulseRate > 110) ||
    (respRate > 0 && respRate > 24)
  ) {
    return "Urgent";
  }

  return "Routine";
}

function updateTriageRecommendationField() {
  const triageInput = byId("triageRecommendation");
  if (!triageInput) {
    return;
  }

  const risk = byId("risk");
  const temperature = byId("temperature");
  const spo2 = byId("spo2");
  const pulseRate = byId("pulseRate");
  const respRate = byId("respRate");
  const bpSystolic = byId("bpSystolic");
  const bloodSugar = byId("bloodSugar");
  const painScore = byId("painScore");
  const oxygenSupport = byId("oxygenSupport");

  triageInput.value = recommendTriageLevel({
    risk: risk ? risk.innerText : 0,
    temperature: temperature ? temperature.value : "",
    spo2: spo2 ? spo2.value : "",
    pulseRate: pulseRate ? pulseRate.value : "",
    respRate: respRate ? respRate.value : "",
    bpSystolic: bpSystolic ? bpSystolic.value : "",
    bloodSugar: bloodSugar ? bloodSugar.value : "",
    painScore: painScore ? painScore.value : "",
    oxygenSupport: oxygenSupport ? oxygenSupport.value : ""
  });
}

function applyDateLimits() {
  const today = new Date().toISOString().split("T")[0];

  const dob = byId("dob");
  if (dob) {
    dob.max = today;
  }

  const visitDate = byId("visitDate");
  if (visitDate) {
    visitDate.max = today;
    if (!visitDate.value) {
      visitDate.value = today;
    }
  }

  const followUpDate = byId("followUpDate");
  if (followUpDate) {
    followUpDate.min = visitDate && visitDate.value ? visitDate.value : today;
  }
}

function setupFormHandlers() {
  const loginForm = byId("loginForm");
  if (loginForm) {
    const handleOtpAction = () => {
      const otpBox = byId("otpBox");
      const otpVisible = otpBox && !otpBox.hidden;
      if (otpVisible) {
        verify();
      } else {
        sendOTP();
      }
    };

    loginForm.addEventListener("submit", (event) => {
      event.preventDefault();
      handleOtpAction();
    });

    loginForm.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      handleOtpAction();
    });

    const sendOtpBtn = byId("sendOtpBtn");
    if (sendOtpBtn) {
      sendOtpBtn.addEventListener("click", (event) => {
        event.preventDefault();
        handleOtpAction();
      });
    }
  }

  const detailsForm = byId("detailsForm");
  if (detailsForm) {
    detailsForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitData();
    });
  }

  const phoneInput = byId("phone");
  if (phoneInput && phoneInput.tagName === "INPUT") {
    phoneInput.addEventListener("input", normalizePhoneInput);
  }

  const emailLoginInput = byId("emailLogin");
  if (emailLoginInput && emailLoginInput.tagName === "INPUT") {
    emailLoginInput.addEventListener("blur", () => {
      emailLoginInput.value = normalizeEmail(emailLoginInput.value);
    });
  }

  const emergencyContact = byId("emergencyContact");
  if (emergencyContact && emergencyContact.tagName === "INPUT") {
    emergencyContact.addEventListener("input", normalizePhoneInput);
  }

  const alternatePhone = byId("alternatePhone");
  if (alternatePhone && alternatePhone.tagName === "INPUT") {
    alternatePhone.addEventListener("input", normalizePhoneInput);
  }

  const pincodeInput = byId("pincode");
  if (pincodeInput && pincodeInput.tagName === "INPUT") {
    pincodeInput.addEventListener("input", (event) => {
      event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6);
    });
  }

  const insuranceInput = byId("insuranceId");
  if (insuranceInput && insuranceInput.tagName === "INPUT") {
    insuranceInput.addEventListener("input", (event) => {
      event.target.value = event.target.value.replace(/[^\w-]/g, "").toUpperCase();
    });
  }

  const occupationInput = byId("occupation");
  if (occupationInput && occupationInput.tagName === "INPUT") {
    occupationInput.addEventListener("input", (event) => {
      event.target.value = event.target.value.replace(/[^a-zA-Z\s.'-]/g, "").slice(0, 60);
    });
  }

  const otpInput = byId("otp");
  if (otpInput) {
    otpInput.addEventListener("input", (event) => {
      event.target.value = event.target.value.replace(/\D/g, "").slice(0, 4);
    });
  }

  const clinicCode = byId("clinicCode");
  if (clinicCode && clinicCode.tagName === "INPUT") {
    clinicCode.addEventListener("input", normalizeTextInput);
  }

  const visitDate = byId("visitDate");
  const followUpDate = byId("followUpDate");
  if (visitDate && followUpDate) {
    visitDate.addEventListener("change", () => {
      const minDate = visitDate.value || new Date().toISOString().split("T")[0];
      followUpDate.min = minDate;
      if (followUpDate.value && followUpDate.value < minDate) {
        followUpDate.value = minDate;
      }
    });
  }

  const dobInput = byId("dob");
  if (dobInput && dobInput.tagName === "INPUT") {
    dobInput.addEventListener("change", () => {
      const patientAge = byId("patientAge");
      if (patientAge) {
        patientAge.value = calculateAgeFromDOB(dobInput.value);
      }
    });
  }

  const weightInput = byId("weight");
  const heightInput = byId("height");
  if (weightInput && heightInput) {
    weightInput.addEventListener("input", updateBMIField);
    heightInput.addEventListener("input", updateBMIField);
  }

  [
    "temperature",
    "spo2",
    "pulseRate",
    "respRate",
    "painScore",
    "oxygenSupport",
    "bpSystolic",
    "bpDiastolic",
    "bloodSugar"
  ].forEach((id) => {
    const input = byId(id);
    if (input) {
      input.addEventListener("input", updateTriageRecommendationField);
      input.addEventListener("change", updateTriageRecommendationField);
    }
  });
}

function hydrateSharedData() {
  const clinicInput = byId("clinicCode");
  if (clinicInput && clinicInput.tagName === "INPUT" && !clinicInput.value) {
    clinicInput.value = localStorage.getItem(STORAGE_KEYS.CLINIC_CODE) || "";
  }

  const phoneInput = byId("phone");
  if (phoneInput && phoneInput.tagName === "INPUT" && !phoneInput.value) {
    phoneInput.value = localStorage.getItem(STORAGE_KEYS.PHONE) || "";
  }

  const nameInput = byId("name");
  if (nameInput && nameInput.tagName === "INPUT" && !nameInput.value) {
    nameInput.value = localStorage.getItem(STORAGE_KEYS.NAME) || "";
  }

  const dobInput = byId("dob");
  if (dobInput && dobInput.tagName === "INPUT" && !dobInput.value) {
    dobInput.value = localStorage.getItem(STORAGE_KEYS.DOB) || "";
  }

  const genderInput = byId("gender");
  if (genderInput && genderInput.tagName === "SELECT" && !genderInput.value) {
    genderInput.value = localStorage.getItem(STORAGE_KEYS.GENDER) || "";
  }

  const stateInput = byId("state");
  if (stateInput && stateInput.tagName === "SELECT" && !stateInput.value) {
    stateInput.value = localStorage.getItem(STORAGE_KEYS.STATE) || "";
  }

  const cityInput = byId("city");
  if (cityInput && cityInput.tagName === "INPUT" && !cityInput.value) {
    cityInput.value = localStorage.getItem(STORAGE_KEYS.CITY) || "";
  }

  const pincodeInput = byId("pincode");
  if (pincodeInput && pincodeInput.tagName === "INPUT" && !pincodeInput.value) {
    pincodeInput.value = localStorage.getItem(STORAGE_KEYS.PINCODE) || "";
  }

  const addressInput = byId("address");
  if (addressInput && addressInput.tagName === "INPUT" && !addressInput.value) {
    addressInput.value = localStorage.getItem(STORAGE_KEYS.ADDRESS) || "";
  }

  const emailInput = byId("email");
  if (emailInput && emailInput.tagName === "INPUT" && !emailInput.value) {
    emailInput.value = localStorage.getItem(STORAGE_KEYS.EMAIL) || "";
  }

  const occupationInput = byId("occupation");
  if (occupationInput && occupationInput.tagName === "INPUT" && !occupationInput.value) {
    occupationInput.value = localStorage.getItem(STORAGE_KEYS.OCCUPATION) || "";
  }

  const emergencyRelationInput = byId("emergencyRelation");
  if (emergencyRelationInput && emergencyRelationInput.tagName === "SELECT" && !emergencyRelationInput.value) {
    emergencyRelationInput.value = localStorage.getItem(STORAGE_KEYS.EMERGENCY_RELATION) || "";
  }

  const alternatePhoneInput = byId("alternatePhone");
  if (alternatePhoneInput && alternatePhoneInput.tagName === "INPUT" && !alternatePhoneInput.value) {
    alternatePhoneInput.value = localStorage.getItem(STORAGE_KEYS.ALTERNATE_PHONE) || "";
  }

  const maritalStatusInput = byId("maritalStatus");
  if (maritalStatusInput && maritalStatusInput.tagName === "SELECT" && !maritalStatusInput.value) {
    maritalStatusInput.value = localStorage.getItem(STORAGE_KEYS.MARITAL_STATUS) || "";
  }

  const emailLoginInput = byId("emailLogin");
  if (emailLoginInput && emailLoginInput.tagName === "INPUT" && !emailLoginInput.value) {
    emailLoginInput.value =
      localStorage.getItem(STORAGE_KEYS.LOGIN_EMAIL) ||
      localStorage.getItem(STORAGE_KEYS.EMAIL) ||
      "";
  }

  const insuranceInput = byId("insuranceId");
  if (insuranceInput && insuranceInput.tagName === "INPUT" && !insuranceInput.value) {
    insuranceInput.value = localStorage.getItem(STORAGE_KEYS.INSURANCE_ID) || "";
  }

  const bloodGroupInput = byId("bloodGroup");
  if (bloodGroupInput && bloodGroupInput.tagName === "SELECT" && !bloodGroupInput.value) {
    bloodGroupInput.value = localStorage.getItem(STORAGE_KEYS.BLOOD_GROUP) || "";
  }

  const emergencyInput = byId("emergencyContact");
  if (emergencyInput && emergencyInput.tagName === "INPUT" && !emergencyInput.value) {
    emergencyInput.value = localStorage.getItem(STORAGE_KEYS.EMERGENCY_CONTACT) || "";
  }

  const username = byId("username");
  if (username) {
    username.innerText = localStorage.getItem(STORAGE_KEYS.NAME) || "User";
  }

  const dob = byId("dob");
  if (dob && dob.tagName !== "INPUT") {
    dob.innerText = localStorage.getItem(STORAGE_KEYS.DOB) || "-";
  }

  const state = byId("state");
  if (state && state.tagName !== "SELECT") {
    state.innerText = localStorage.getItem(STORAGE_KEYS.STATE) || "-";
  }

  const gender = byId("gender");
  if (gender && gender.tagName !== "SELECT") {
    gender.innerText = localStorage.getItem(STORAGE_KEYS.GENDER) || "-";
  }

  const bloodGroup = byId("bloodGroup");
  if (bloodGroup && bloodGroup.tagName !== "SELECT") {
    bloodGroup.innerText = localStorage.getItem(STORAGE_KEYS.BLOOD_GROUP) || "-";
  }

  const city = byId("city");
  if (city && city.tagName !== "INPUT") {
    city.innerText = localStorage.getItem(STORAGE_KEYS.CITY) || "-";
  }

  const pincode = byId("pincode");
  if (pincode && pincode.tagName !== "INPUT") {
    pincode.innerText = localStorage.getItem(STORAGE_KEYS.PINCODE) || "-";
  }

  const address = byId("address");
  if (address && address.tagName !== "INPUT") {
    address.innerText = localStorage.getItem(STORAGE_KEYS.ADDRESS) || "-";
  }

  const email = byId("email");
  if (email && email.tagName !== "INPUT") {
    email.innerText = localStorage.getItem(STORAGE_KEYS.EMAIL) || "-";
  }

  const occupation = byId("occupation");
  if (occupation && occupation.tagName !== "INPUT") {
    occupation.innerText = localStorage.getItem(STORAGE_KEYS.OCCUPATION) || "-";
  }

  const emergencyRelation = byId("emergencyRelation");
  if (emergencyRelation && emergencyRelation.tagName !== "SELECT") {
    emergencyRelation.innerText = localStorage.getItem(STORAGE_KEYS.EMERGENCY_RELATION) || "-";
  }

  const alternatePhone = byId("alternatePhone");
  if (alternatePhone && alternatePhone.tagName !== "INPUT") {
    alternatePhone.innerText = localStorage.getItem(STORAGE_KEYS.ALTERNATE_PHONE) || "-";
  }

  const maritalStatus = byId("maritalStatus");
  if (maritalStatus && maritalStatus.tagName !== "SELECT") {
    maritalStatus.innerText = localStorage.getItem(STORAGE_KEYS.MARITAL_STATUS) || "-";
  }

  const insurance = byId("insuranceId");
  if (insurance && insurance.tagName !== "INPUT") {
    insurance.innerText = localStorage.getItem(STORAGE_KEYS.INSURANCE_ID) || "-";
  }

  const emergency = byId("emergencyContact");
  if (emergency && emergency.tagName !== "INPUT") {
    emergency.innerText = localStorage.getItem(STORAGE_KEYS.EMERGENCY_CONTACT) || "-";
  }

  const clinic = byId("clinicCode");
  if (clinic && clinic.tagName !== "INPUT") {
    clinic.innerText = localStorage.getItem(STORAGE_KEYS.CLINIC_CODE) || "-";
  }

  const phone = byId("phone");
  if (phone && phone.tagName !== "INPUT") {
    phone.innerText = localStorage.getItem(STORAGE_KEYS.PHONE) || "-";
  }

  const patientName = byId("patientName");
  if (patientName && patientName.tagName === "INPUT" && !patientName.value) {
    patientName.value = localStorage.getItem(STORAGE_KEYS.NAME) || "";
  }

  const patientAge = byId("patientAge");
  if (patientAge && patientAge.tagName === "INPUT" && !patientAge.value) {
    patientAge.value = calculateAgeFromDOB(localStorage.getItem(STORAGE_KEYS.DOB) || "");
  }

  updateTriageRecommendationField();
}

function restoreDraftIfAvailable() {
  const patientName = byId("patientName");
  if (!patientName) {
    return;
  }

  const draft = getStoredJSON(STORAGE_KEYS.DRAFT_REPORT, null);
  if (!draft) {
    return;
  }

  const fields = [
    ["patientName", "patientName"],
    ["patientAge", "patientAge"],
    ["visitDate", "visitDate"],
    ["followUpDate", "followUpDate"],
    ["priority", "priority"],
    ["admissionStatus", "admissionStatus"],
    ["disposition", "disposition"],
    ["consultationType", "consultationType"],
    ["chiefComplaint", "chiefComplaint"],
    ["chiefComplaintDuration", "chiefComplaintDuration"],
    ["painLocation", "painLocation"],
    ["conversation", "conversation"],
    ["knownAllergies", "knownAllergies"],
    ["medicationAdherence", "medicationAdherence"],
    ["comorbidities", "comorbidities"],
    ["painScore", "painScore"],
    ["oxygenSupport", "oxygenSupport"],
    ["temperature", "temperature"],
    ["spo2", "spo2"],
    ["weight", "weight"],
    ["height", "height"],
    ["bmi", "bmi"],
    ["pulseRate", "pulseRate"],
    ["respRate", "respRate"],
    ["bloodSugar", "bloodSugar"],
    ["bpSystolic", "bpSystolic"],
    ["bpDiastolic", "bpDiastolic"],
    ["symptoms", "symptoms"],
    ["diagnosis", "diagnosis"],
    ["medicines", "medicines"],
    ["tests", "tests"],
    ["carePlan", "carePlan"],
    ["clinicalNotes", "clinicalNotes"],
    ["doctor", "doctor"],
    ["triageRecommendation", "triageRecommendation"]
  ];

  fields.forEach(([id, key]) => {
    const input = byId(id);
    if (input && !input.value && draft[key]) {
      input.value = draft[key];
    }
  });

  const visitDate = byId("visitDate");
  const followUpDate = byId("followUpDate");
  if (visitDate && followUpDate && visitDate.value) {
    followUpDate.min = visitDate.value;
  }

  if (draft.risk !== undefined && draft.risk !== null) {
    const risk = byId("risk");
    const riskLevel = byId("riskLevel");
    if (risk) {
      risk.innerText = String(draft.risk);
    }
    if (riskLevel) {
      riskLevel.innerText = getRiskLevel(Number(draft.risk));
    }
  }

  updateBMIField();
  updateTriageRecommendationField();

  showMessage("newDataMessage", "Draft restored successfully.");
}

function isLoginPage() {
  return document.body && document.body.classList.contains("login-page");
}

function ensureSession() {
  if (isLoginPage()) {
    return;
  }

  const token = getSessionToken();
  if (!token) {
    window.location.href = "login.html";
  }
}

async function syncProfileFromServer() {
  const response = await apiRequest("/profile");
  if (!response.ok || !response.data || !response.data.profile) {
    return;
  }

  const profile = response.data.profile;
  const keyMap = [
    [STORAGE_KEYS.PHONE, "phone"],
    [STORAGE_KEYS.LOGIN_EMAIL, "loginEmail"],
    [STORAGE_KEYS.CLINIC_CODE, "clinicCode"],
    [STORAGE_KEYS.NAME, "name"],
    [STORAGE_KEYS.DOB, "dob"],
    [STORAGE_KEYS.GENDER, "gender"],
    [STORAGE_KEYS.BLOOD_GROUP, "bloodGroup"],
    [STORAGE_KEYS.STATE, "state"],
    [STORAGE_KEYS.CITY, "city"],
    [STORAGE_KEYS.PINCODE, "pincode"],
    [STORAGE_KEYS.ADDRESS, "address"],
    [STORAGE_KEYS.EMAIL, "email"],
    [STORAGE_KEYS.OCCUPATION, "occupation"],
    [STORAGE_KEYS.EMERGENCY_RELATION, "emergencyRelation"],
    [STORAGE_KEYS.INSURANCE_ID, "insuranceId"],
    [STORAGE_KEYS.ALTERNATE_PHONE, "alternatePhone"],
    [STORAGE_KEYS.MARITAL_STATUS, "maritalStatus"],
    [STORAGE_KEYS.EMERGENCY_CONTACT, "emergencyContact"]
  ];

  keyMap.forEach(([storageKey, profileKey]) => {
    const value = profile[profileKey];
    if (value !== undefined && value !== null) {
      localStorage.setItem(storageKey, String(value));
    }
  });
}

async function syncReportsFromServer() {
  const response = await apiRequest("/reports");
  if (!response.ok || !response.data || !Array.isArray(response.data.reports)) {
    return;
  }

  setStoredJSON(STORAGE_KEYS.REPORTS, response.data.reports);
}

async function syncFromServer() {
  if (!getSessionToken()) {
    return;
  }

  await syncProfileFromServer();
  await syncReportsFromServer();
}

async function initPage() {
  ensureSession();
  await syncFromServer();
  applyDateLimits();
  setupFormHandlers();
  setupSidebarBehavior();
  hydrateSharedData();
  restoreDraftIfAvailable();
  resetOtpMeta();

  if (byId("reportContainer")) {
    loadReports();
  }

  if (byId("statTotal")) {
    updateDashboardStats();
  }
}

document.addEventListener("DOMContentLoaded", initPage);

function setupSidebarBehavior() {
  const side = byId("side");
  const menuButton = document.querySelector(".menu");

  if (!side || !menuButton) {
    return;
  }

  side.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      side.classList.remove("open");
    });
  });

  document.addEventListener("click", (event) => {
    if (!side.classList.contains("open")) {
      return;
    }

    if (side.contains(event.target) || menuButton.contains(event.target)) {
      return;
    }

    side.classList.remove("open");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      side.classList.remove("open");
    }
  });
}

function startOtpCooldown(totalSeconds = OTP_COOLDOWN_SECONDS) {
  const resendBtn = byId("resendBtn");
  if (!resendBtn) {
    return;
  }

  clearInterval(otpCooldownInterval);

  let seconds = Math.max(0, Number(totalSeconds) || 0);
  if (seconds <= 0) {
    resendBtn.disabled = false;
    resendBtn.textContent = "Resend OTP";
    return;
  }

  resendBtn.disabled = true;
  resendBtn.textContent = `Resend OTP (${seconds}s)`;

  otpCooldownInterval = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(otpCooldownInterval);
      otpCooldownInterval = null;
      resendBtn.disabled = false;
      resendBtn.textContent = "Resend OTP";
      return;
    }
    resendBtn.textContent = `Resend OTP (${seconds}s)`;
  }, 1000);
}

async function sendOTP() {
  const identifier = resolveOtpIdentifier();
  if (identifier.error) {
    showMessage("authMessage", identifier.error, "error");
    if (identifier.focus) {
      identifier.focus.focus();
    }
    return;
  }

  const sendOtpBtn = byId("sendOtpBtn");
  setButtonBusy(sendOtpBtn, true, "Sending OTP...");

  const loginPhone = identifier.phone;
  const loginEmail = identifier.email;
  const clinicCodeInput = byId("clinicCode");
  const clinicCode = clinicCodeInput ? clinicCodeInput.value.trim().toUpperCase() : "";
  try {
    localStorage.removeItem(STORAGE_KEYS.SESSION_TOKEN);
    const response = await apiRequest("/send-otp", {
      method: "POST",
      body: JSON.stringify({ phone: loginPhone, email: loginEmail, clinicCode }),
      skipAuth: true
    });

    if (!response.ok) {
      const retryAfterSeconds = Number(response.data && response.data.retryAfterSeconds);
      if (response.status === 429 && retryAfterSeconds > 0) {
        startOtpCooldown(retryAfterSeconds);
      }
      showMessage("authMessage", response.message, "error");
      return;
    }

    generatedOtp = String((response.data && response.data.demoOtp) || "");
    if (generatedOtp) {
      localStorage.setItem(STORAGE_KEYS.GENERATED_OTP, generatedOtp);
    } else {
      localStorage.removeItem(STORAGE_KEYS.GENERATED_OTP);
    }
    localStorage.setItem(STORAGE_KEYS.OTP_IDENTIFIER, loginEmail || loginPhone);
    localStorage.setItem(STORAGE_KEYS.OTP_IDENTIFIER_TYPE, identifier.type);
    if (loginPhone) {
      localStorage.setItem(STORAGE_KEYS.PHONE, loginPhone);
    } else {
      localStorage.removeItem(STORAGE_KEYS.PHONE);
    }
    if (loginEmail) {
      localStorage.setItem(STORAGE_KEYS.LOGIN_EMAIL, loginEmail);
      localStorage.setItem(STORAGE_KEYS.EMAIL, loginEmail);
    } else {
      localStorage.removeItem(STORAGE_KEYS.LOGIN_EMAIL);
    }
    localStorage.setItem(STORAGE_KEYS.OTP_SENT_AT, String(Date.now()));
    localStorage.setItem(STORAGE_KEYS.CLINIC_CODE, clinicCode);

    const otpBox = byId("otpBox");
    if (otpBox) {
      otpBox.hidden = false;
    }

    const otpInput = byId("otp");
    if (otpInput) {
      otpInput.value = "";
      otpInput.focus();
    }

    const cooldownSeconds = Number((response.data && response.data.cooldownSeconds) || OTP_COOLDOWN_SECONDS);
    const expiresInSeconds = Number((response.data && response.data.expiresInSeconds) || 180);
    startOtpCooldown(cooldownSeconds);
    startOtpExpiryCountdown(expiresInSeconds);

    const sentTo = loginEmail || loginPhone || "selected contact";
    const demoOtpNote = generatedOtp ? ` Demo OTP: ${generatedOtp}` : "";
    showMessage("authMessage", `OTP sent to ${sentTo}.${demoOtpNote}`);
  } finally {
    setButtonBusy(sendOtpBtn, false);
  }
}

function resendOTP() {
  const resendBtn = byId("resendBtn");
  if (resendBtn && resendBtn.disabled) {
    return;
  }

  const sentAt = Number(localStorage.getItem(STORAGE_KEYS.OTP_SENT_AT) || "0");
  const waitMs = OTP_COOLDOWN_SECONDS * 1000;
  const remaining = waitMs - (Date.now() - sentAt);

  if (remaining > 0) {
    const seconds = Math.ceil(remaining / 1000);
    showMessage("authMessage", `Please wait ${seconds}s before requesting a new OTP.`, "error");
    startOtpCooldown(seconds);
    return;
  }

  sendOTP();
}

async function verify() {
  const otpInput = byId("otp");
  if (!otpInput) {
    return;
  }

  const entered = otpInput.value.trim();
  const identifierType = localStorage.getItem(STORAGE_KEYS.OTP_IDENTIFIER_TYPE) || "";
  const identifierValue = localStorage.getItem(STORAGE_KEYS.OTP_IDENTIFIER) || "";
  const storedPhone = localStorage.getItem(STORAGE_KEYS.PHONE) || "";
  const storedEmail = normalizeEmail(localStorage.getItem(STORAGE_KEYS.LOGIN_EMAIL) || "");
  let phone = "";
  let email = "";

  if (identifierType === "phone") {
    phone = identifierValue || storedPhone;
  } else if (identifierType === "email") {
    email = normalizeEmail(identifierValue || storedEmail);
  } else if (EMAIL_PATTERN.test(identifierValue)) {
    email = normalizeEmail(identifierValue);
  } else if (PHONE_PATTERN.test(identifierValue)) {
    phone = identifierValue;
  } else if (storedEmail) {
    email = storedEmail;
  } else {
    phone = storedPhone;
  }

  if (!/^\d{4}$/.test(entered)) {
    showMessage("authMessage", "OTP must be a 4-digit number.", "error");
    otpInput.focus();
    return;
  }

  if (!phone && !email) {
    showMessage("authMessage", "Login identifier missing. Please request OTP again.", "error");
    return;
  }

  const verifyBtn = byId("verifyBtn");
  setButtonBusy(verifyBtn, true, "Verifying...");

  try {
    const response = await apiRequest("/verify-otp", {
      method: "POST",
      body: JSON.stringify({ phone, email, otp: entered }),
      skipAuth: true
    });

    if (!response.ok) {
      showMessage("authMessage", response.message, "error");
      return;
    }

    clearInterval(otpCooldownInterval);
    otpCooldownInterval = null;
    clearInterval(otpExpiryInterval);
    otpExpiryInterval = null;
    resetOtpMeta();

    localStorage.removeItem(STORAGE_KEYS.GENERATED_OTP);
    localStorage.removeItem(STORAGE_KEYS.OTP_SENT_AT);
    localStorage.removeItem(STORAGE_KEYS.OTP_IDENTIFIER);
    localStorage.removeItem(STORAGE_KEYS.OTP_IDENTIFIER_TYPE);
    localStorage.setItem(STORAGE_KEYS.SESSION_TOKEN, response.data.sessionToken || "");
    const responsePhone = String((response.data && response.data.phone) || "").trim();
    const responseEmail = normalizeEmail((response.data && response.data.email) || "");

    if (responsePhone) {
      localStorage.setItem(STORAGE_KEYS.PHONE, responsePhone);
    } else {
      localStorage.removeItem(STORAGE_KEYS.PHONE);
    }

    if (responseEmail) {
      localStorage.setItem(STORAGE_KEYS.LOGIN_EMAIL, responseEmail);
      localStorage.setItem(STORAGE_KEYS.EMAIL, responseEmail);
    }

    window.location.href = "details.html";
  } finally {
    setButtonBusy(verifyBtn, false);
  }
}

async function submitData() {
  const name = byId("name");
  const dob = byId("dob");
  const gender = byId("gender");
  const state = byId("state");
  const city = byId("city");
  const pincode = byId("pincode");
  const address = byId("address");
  const email = byId("email");
  const occupation = byId("occupation");
  const emergencyRelation = byId("emergencyRelation");
  const insuranceId = byId("insuranceId");
  const alternatePhone = byId("alternatePhone");
  const maritalStatus = byId("maritalStatus");
  const bloodGroup = byId("bloodGroup");
  const emergencyContact = byId("emergencyContact");
  const phone = byId("phone");

  if (!name || !dob || !gender || !state || !city || !pincode || !address || !email || !bloodGroup || !emergencyContact) {
    return;
  }

  const fullName = name.value.trim();
  const dobValue = dob.value;
  const genderValue = gender.value;
  const stateValue = state.value;
  const cityValue = city.value.trim();
  const pincodeValue = pincode.value.trim();
  const addressValue = address.value.trim();
  const emailValue = email.value.trim().toLowerCase();
  const occupationValue = occupation ? occupation.value.trim() : "";
  const emergencyRelationValue = emergencyRelation ? emergencyRelation.value : "";
  const insuranceValue = insuranceId ? insuranceId.value.trim().toUpperCase() : "";
  const alternatePhoneValue = alternatePhone ? alternatePhone.value.trim() : "";
  const maritalStatusValue = maritalStatus ? maritalStatus.value : "";
  const bloodGroupValue = bloodGroup.value;
  const emergencyValue = emergencyContact.value.trim();
  const phoneValue = phone ? phone.value.trim() : "";
  const allowedMaritalStatuses = new Set(["", "Single", "Married", "Divorced", "Widowed"]);

  if (!/^[a-zA-Z\s.'-]{2,60}$/.test(fullName)) {
    showMessage("profileMessage", "Enter a valid full name.", "error");
    name.focus();
    return;
  }

  if (!dobValue) {
    showMessage("profileMessage", "Date of birth is required.", "error");
    dob.focus();
    return;
  }

  const dobDate = new Date(dobValue);
  const now = new Date();
  if (dobDate > now) {
    showMessage("profileMessage", "Date of birth cannot be in the future.", "error");
    dob.focus();
    return;
  }

  if (!stateValue) {
    showMessage("profileMessage", "Please select a state.", "error");
    state.focus();
    return;
  }

  if (!genderValue) {
    showMessage("profileMessage", "Please select gender.", "error");
    gender.focus();
    return;
  }

  if (cityValue.length < 2) {
    showMessage("profileMessage", "Please enter a valid city.", "error");
    city.focus();
    return;
  }

  if (!/^\d{6}$/.test(pincodeValue)) {
    showMessage("profileMessage", "Pincode must be a valid 6-digit number.", "error");
    pincode.focus();
    return;
  }

  if (addressValue.length < 5) {
    showMessage("profileMessage", "Please enter a valid address.", "error");
    address.focus();
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue)) {
    showMessage("profileMessage", "Please enter a valid email address.", "error");
    email.focus();
    return;
  }

  if (occupationValue && !/^[a-zA-Z\s.'-]{2,60}$/.test(occupationValue)) {
    showMessage("profileMessage", "Occupation should contain letters only.", "error");
    occupation.focus();
    return;
  }

  if (emergencyRelationValue && !/^[a-zA-Z\s]{2,30}$/.test(emergencyRelationValue)) {
    showMessage("profileMessage", "Please select a valid emergency relation.", "error");
    emergencyRelation.focus();
    return;
  }

  if (!/^\d{10}$/.test(emergencyValue)) {
    showMessage("profileMessage", "Emergency contact must be a valid 10-digit number.", "error");
    emergencyContact.focus();
    return;
  }

  if (alternatePhoneValue && !/^\d{10}$/.test(alternatePhoneValue)) {
    showMessage("profileMessage", "Alternate phone must be a valid 10-digit number.", "error");
    if (alternatePhone) {
      alternatePhone.focus();
    }
    return;
  }

  if (phoneValue && emergencyValue === phoneValue) {
    showMessage("profileMessage", "Emergency contact should be different from login phone.", "error");
    emergencyContact.focus();
    return;
  }

  if (alternatePhoneValue && phoneValue && alternatePhoneValue === phoneValue) {
    showMessage("profileMessage", "Alternate phone should be different from login phone.", "error");
    if (alternatePhone) {
      alternatePhone.focus();
    }
    return;
  }

  if (alternatePhoneValue && alternatePhoneValue === emergencyValue) {
    showMessage("profileMessage", "Alternate phone should be different from emergency contact.", "error");
    if (alternatePhone) {
      alternatePhone.focus();
    }
    return;
  }

  if (!allowedMaritalStatuses.has(maritalStatusValue)) {
    showMessage("profileMessage", "Please select a valid marital status.", "error");
    if (maritalStatus) {
      maritalStatus.focus();
    }
    return;
  }

  localStorage.setItem(STORAGE_KEYS.NAME, fullName);
  localStorage.setItem(STORAGE_KEYS.DOB, dobValue);
  localStorage.setItem(STORAGE_KEYS.GENDER, genderValue);
  localStorage.setItem(STORAGE_KEYS.BLOOD_GROUP, bloodGroupValue);
  localStorage.setItem(STORAGE_KEYS.STATE, stateValue);
  localStorage.setItem(STORAGE_KEYS.CITY, cityValue);
  localStorage.setItem(STORAGE_KEYS.PINCODE, pincodeValue);
  localStorage.setItem(STORAGE_KEYS.ADDRESS, addressValue);
  localStorage.setItem(STORAGE_KEYS.EMAIL, emailValue);
  localStorage.setItem(STORAGE_KEYS.OCCUPATION, occupationValue);
  localStorage.setItem(STORAGE_KEYS.EMERGENCY_RELATION, emergencyRelationValue);
  localStorage.setItem(STORAGE_KEYS.INSURANCE_ID, insuranceValue);
  localStorage.setItem(STORAGE_KEYS.ALTERNATE_PHONE, alternatePhoneValue);
  localStorage.setItem(STORAGE_KEYS.MARITAL_STATUS, maritalStatusValue);
  localStorage.setItem(STORAGE_KEYS.EMERGENCY_CONTACT, emergencyValue);

  const response = await apiRequest("/profile", {
    method: "POST",
    body: JSON.stringify({
      phone: phoneValue,
      clinicCode: localStorage.getItem(STORAGE_KEYS.CLINIC_CODE) || "",
      name: fullName,
      dob: dobValue,
      gender: genderValue,
      bloodGroup: bloodGroupValue,
      state: stateValue,
      city: cityValue,
      pincode: pincodeValue,
      address: addressValue,
      email: emailValue,
      occupation: occupationValue,
      emergencyRelation: emergencyRelationValue,
      insuranceId: insuranceValue,
      alternatePhone: alternatePhoneValue,
      maritalStatus: maritalStatusValue,
      emergencyContact: emergencyValue
    })
  });

  if (!response.ok) {
    showMessage("profileMessage", response.message, "error");
    return;
  }

  window.location.href = "dashboard.html";
}

function toggle() {
  const side = byId("side");
  if (!side) {
    return;
  }

  side.classList.toggle("open");
}

async function logout() {
  await apiRequest("/logout", { method: "POST" });
  clearInterval(otpCooldownInterval);
  otpCooldownInterval = null;
  clearInterval(otpExpiryInterval);
  otpExpiryInterval = null;
  localStorage.removeItem(STORAGE_KEYS.PHONE);
  localStorage.removeItem(STORAGE_KEYS.LOGIN_EMAIL);
  localStorage.removeItem(STORAGE_KEYS.SESSION_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.GENERATED_OTP);
  localStorage.removeItem(STORAGE_KEYS.OTP_SENT_AT);
  localStorage.removeItem(STORAGE_KEYS.OTP_IDENTIFIER);
  localStorage.removeItem(STORAGE_KEYS.OTP_IDENTIFIER_TYPE);
  localStorage.removeItem(STORAGE_KEYS.CLINIC_CODE);
  localStorage.removeItem(STORAGE_KEYS.NAME);
  localStorage.removeItem(STORAGE_KEYS.DOB);
  localStorage.removeItem(STORAGE_KEYS.GENDER);
  localStorage.removeItem(STORAGE_KEYS.BLOOD_GROUP);
  localStorage.removeItem(STORAGE_KEYS.STATE);
  localStorage.removeItem(STORAGE_KEYS.CITY);
  localStorage.removeItem(STORAGE_KEYS.PINCODE);
  localStorage.removeItem(STORAGE_KEYS.ADDRESS);
  localStorage.removeItem(STORAGE_KEYS.EMAIL);
  localStorage.removeItem(STORAGE_KEYS.OCCUPATION);
  localStorage.removeItem(STORAGE_KEYS.EMERGENCY_RELATION);
  localStorage.removeItem(STORAGE_KEYS.INSURANCE_ID);
  localStorage.removeItem(STORAGE_KEYS.ALTERNATE_PHONE);
  localStorage.removeItem(STORAGE_KEYS.MARITAL_STATUS);
  localStorage.removeItem(STORAGE_KEYS.EMERGENCY_CONTACT);
  localStorage.removeItem(STORAGE_KEYS.CURRENT_REPORT);
  localStorage.removeItem(STORAGE_KEYS.DRAFT_REPORT);
  window.location.href = "login.html";
}

function startConversation() {
  if (monitoringActive) {
    showMessage("newDataMessage", "Conversation capture is already running.", "error");
    return;
  }

  monitoringActive = true;
  startCamera();
  startVoice();
  startBreathing();
  startPulse();
  showMessage("newDataMessage", "Conversation capture started.");
}

function stopConversation() {
  monitoringActive = false;

  if (recognition) {
    recognition.onend = null;
    recognition.stop();
    recognition = null;
  }

  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }

  clearInterval(breathInterval);
  clearInterval(pulseInterval);
  breathInterval = null;
  pulseInterval = null;

  const breathing = byId("breathing");
  const heart = byId("heart");

  if (breathing) {
    breathing.innerText = "Idle";
  }

  if (heart) {
    heart.innerText = "Idle";
  }

  showMessage("newDataMessage", "Conversation capture stopped.");
}

async function startCamera() {
  const video = byId("video");
  if (!video || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    video.srcObject = cameraStream;
  } catch (error) {
    showMessage("newDataMessage", "Camera access is blocked. Monitoring will continue without video.", "error");
  }
}

function startVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const conversation = byId("conversation");

  if (!SpeechRecognition || !conversation) {
    showMessage("newDataMessage", "Speech recognition is not available in this browser.", "error");
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-IN";

  fullTranscript = conversation.value || "";

  recognition.onresult = (event) => {
    let newText = "";

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      if (event.results[i].isFinal) {
        newText += `${event.results[i][0].transcript} `;
      }
    }

    if (newText) {
      fullTranscript += newText;
      conversation.value = fullTranscript.trim();
      runAI();
    }
  };

  recognition.onerror = () => {
    showMessage("newDataMessage", "Speech recognition encountered an issue.", "error");
  };

  recognition.onend = () => {
    if (monitoringActive && recognition) {
      try {
        recognition.start();
      } catch (error) {
        // Ignore repeated start race while stopping.
      }
    }
  };

  try {
    recognition.start();
  } catch (error) {
    showMessage("newDataMessage", "Unable to start speech recognition.", "error");
  }
}

function classifyBreathing(rate) {
  if (rate < 10) {
    return "Low";
  }
  if (rate <= 20) {
    return "Normal";
  }
  return "High";
}

function classifyPulse(rate) {
  if (rate < 60) {
    return "Low";
  }
  if (rate <= 100) {
    return "Normal";
  }
  return "High";
}

function startBreathing() {
  const breathing = byId("breathing");
  if (!breathing) {
    return;
  }

  clearInterval(breathInterval);
  breathInterval = setInterval(() => {
    const bpm = 10 + Math.floor(Math.random() * 14);
    breathing.innerText = `${bpm} BPM (${classifyBreathing(bpm)})`;
  }, 3000);
}

function startPulse() {
  const heart = byId("heart");
  if (!heart) {
    return;
  }

  clearInterval(pulseInterval);
  pulseInterval = setInterval(() => {
    const bpm = 55 + Math.floor(Math.random() * 66);
    heart.innerText = `${bpm} BPM (${classifyPulse(bpm)})`;
  }, 2000);
}

function analyze(text) {
  const db = {
    fever: { w: 20, m: "Paracetamol", t: "Blood Test" },
    cough: { w: 15, m: "Cough Syrup", t: "Chest X-ray" },
    cold: { w: 10, m: "Antihistamine", t: "CBC" },
    headache: { w: 10, m: "Ibuprofen", t: "CT Scan" },
    pain: { w: 18, m: "Analgesic", t: "Pain Panel" },
    dizziness: { w: 20, m: "Hydration + Observation", t: "BP Monitoring" },
    vomiting: { w: 15, m: "ORS", t: "Stool Test" },
    breath: { w: 25, m: "Inhaler", t: "Spirometry" },
    chest: { w: 30, m: "Aspirin", t: "ECG" },
    weakness: { w: 10, m: "Multivitamin", t: "Vitamin Test" },
    fatigue: { w: 12, m: "Nutritional Support", t: "Thyroid Panel" },
    infection: { w: 22, m: "Antibiotic (per doctor)", t: "CRP Test" },
    diarrhea: { w: 18, m: "ORS", t: "Electrolyte Panel" },
    diabetes: { w: 25, m: "Metformin", t: "HbA1c" },
    hypertension: { w: 25, m: "Amlodipine", t: "Blood Pressure Panel" }
  };

  const normalizedText = String(text || "").toLowerCase();
  const symptoms = [];
  const medicines = [];
  const tests = [];
  let risk = 0;

  Object.keys(db).forEach((key) => {
    if (normalizedText.includes(key)) {
      symptoms.push(key);
      medicines.push(db[key].m);
      tests.push(db[key].t);
      risk += db[key].w;
    }
  });

  return {
    symptoms: symptoms.join(", "),
    medicines: [...new Set(medicines)].join(", "),
    tests: [...new Set(tests)].join(", "),
    risk: Math.min(risk, 100)
  };
}

function getRiskLevel(risk) {
  if (risk >= 80) {
    return "Critical";
  }
  if (risk >= 60) {
    return "High";
  }
  if (risk >= 30) {
    return "Moderate";
  }
  return "Low";
}

function runAI() {
  const chiefComplaint = byId("chiefComplaint");
  const conversation = byId("conversation");
  const knownAllergies = byId("knownAllergies");
  const comorbidities = byId("comorbidities");
  const symptoms = byId("symptoms");
  const diagnosis = byId("diagnosis");
  const medicines = byId("medicines");
  const tests = byId("tests");
  const risk = byId("risk");
  const riskLevel = byId("riskLevel");

  if (!conversation || !symptoms || !medicines || !tests || !risk || !diagnosis) {
    return;
  }

  const sourceText = [
    chiefComplaint ? chiefComplaint.value : "",
    conversation.value,
    knownAllergies ? knownAllergies.value : "",
    comorbidities ? comorbidities.value : ""
  ].join(" ");
  const result = analyze(sourceText);

  symptoms.value = result.symptoms || "No clear symptoms detected";
  medicines.value = result.medicines || "Observation / hydration advised";
  tests.value = result.tests || "No immediate test suggested";
  if (!diagnosis.value.trim()) {
    diagnosis.value = result.symptoms
      ? `Likely related to ${result.symptoms}. Clinical confirmation needed.`
      : "Under observation. No strong indicator found from transcript.";
  }
  risk.innerText = String(result.risk);

  if (riskLevel) {
    riskLevel.innerText = getRiskLevel(result.risk);
  }

  updateTriageRecommendationField();
}

function buildCurrentReport() {
  const patientName = byId("patientName");
  const patientAge = byId("patientAge");
  const visitDate = byId("visitDate");
  const followUpDate = byId("followUpDate");
  const priority = byId("priority");
  const admissionStatus = byId("admissionStatus");
  const disposition = byId("disposition");
  const consultationType = byId("consultationType");
  const chiefComplaint = byId("chiefComplaint");
  const chiefComplaintDuration = byId("chiefComplaintDuration");
  const painLocation = byId("painLocation");
  const conversation = byId("conversation");
  const knownAllergies = byId("knownAllergies");
  const medicationAdherence = byId("medicationAdherence");
  const comorbidities = byId("comorbidities");
  const painScore = byId("painScore");
  const oxygenSupport = byId("oxygenSupport");
  const temperature = byId("temperature");
  const spo2 = byId("spo2");
  const weight = byId("weight");
  const height = byId("height");
  const bmi = byId("bmi");
  const pulseRate = byId("pulseRate");
  const respRate = byId("respRate");
  const bloodSugar = byId("bloodSugar");
  const bpSystolic = byId("bpSystolic");
  const bpDiastolic = byId("bpDiastolic");
  const symptoms = byId("symptoms");
  const diagnosis = byId("diagnosis");
  const medicines = byId("medicines");
  const tests = byId("tests");
  const carePlan = byId("carePlan");
  const clinicalNotes = byId("clinicalNotes");
  const doctor = byId("doctor");
  const risk = byId("risk");
  const triageRecommendation = byId("triageRecommendation");
  const breathing = byId("breathing");
  const heart = byId("heart");

  if (!patientName || !visitDate || !symptoms || !medicines || !tests || !doctor || !risk) {
    return null;
  }

  const report = {
    id: `report-${Date.now()}`,
    createdAt: new Date().toISOString(),
    patientName: patientName.value.trim(),
    patientAge: patientAge ? patientAge.value.trim() : "",
    visitDate: visitDate.value,
    followUpDate: followUpDate ? followUpDate.value : "",
    priority: priority ? priority.value : "Routine",
    admissionStatus: admissionStatus ? admissionStatus.value : "Not Admitted",
    disposition: disposition ? disposition.value : "Home Care",
    consultationType: consultationType ? consultationType.value : "In-person",
    chiefComplaint: chiefComplaint ? chiefComplaint.value.trim() : "",
    chiefComplaintDuration: chiefComplaintDuration ? chiefComplaintDuration.value.trim() : "",
    painLocation: painLocation ? painLocation.value.trim() : "",
    conversation: (conversation && conversation.value.trim()) || "",
    knownAllergies: knownAllergies ? knownAllergies.value.trim() : "",
    medicationAdherence: medicationAdherence ? medicationAdherence.value : "Good",
    comorbidities: comorbidities ? comorbidities.value.trim() : "",
    painScore: painScore ? painScore.value : "",
    oxygenSupport: oxygenSupport ? oxygenSupport.value : "Room Air",
    temperature: temperature ? temperature.value : "",
    spo2: spo2 ? spo2.value : "",
    weight: weight ? weight.value : "",
    height: height ? height.value : "",
    bmi: bmi ? (bmi.value || calculateBMI(weight ? weight.value : "", height ? height.value : "")) : "",
    pulseRate: pulseRate ? pulseRate.value : "",
    respRate: respRate ? respRate.value : "",
    bloodSugar: bloodSugar ? bloodSugar.value : "",
    bpSystolic: bpSystolic ? bpSystolic.value : "",
    bpDiastolic: bpDiastolic ? bpDiastolic.value : "",
    symptoms: symptoms.value.trim(),
    diagnosis: diagnosis ? diagnosis.value.trim() : "",
    medicines: medicines.value.trim(),
    tests: tests.value.trim(),
    carePlan: carePlan ? carePlan.value.trim() : "",
    clinicalNotes: (clinicalNotes && clinicalNotes.value.trim()) || "",
    risk: Number(risk.innerText) || 0,
    riskLevel: getRiskLevel(Number(risk.innerText) || 0),
    triageRecommendation: triageRecommendation ? triageRecommendation.value : "",
    doctor: doctor.value.trim(),
    breathing: breathing ? breathing.innerText : "Idle",
    pulse: heart ? heart.innerText : "Idle",
    status: "Generated"
  };

  if (!report.triageRecommendation) {
    report.triageRecommendation = recommendTriageLevel(report);
  }

  return report;
}

function generateReport() {
  const report = buildCurrentReport();
  const preview = byId("preview");
  const after = byId("after");

  if (!report || !preview || !after) {
    showMessage("newDataMessage", "Form elements are missing. Refresh and try again.", "error");
    return;
  }

  if (!report.patientName) {
    showMessage("newDataMessage", "Please enter patient name.", "error");
    byId("patientName").focus();
    return;
  }

  if (!report.visitDate) {
    showMessage("newDataMessage", "Please select visit date.", "error");
    byId("visitDate").focus();
    return;
  }

  if (report.followUpDate && report.followUpDate < report.visitDate) {
    showMessage("newDataMessage", "Follow-up date cannot be before visit date.", "error");
    byId("followUpDate").focus();
    return;
  }

  if ((report.bpSystolic && !report.bpDiastolic) || (!report.bpSystolic && report.bpDiastolic)) {
    showMessage("newDataMessage", "Please enter both BP systolic and diastolic values.", "error");
    (byId("bpSystolic") || byId("bpDiastolic")).focus();
    return;
  }

  if ((report.weight && !report.height) || (!report.weight && report.height)) {
    showMessage("newDataMessage", "Please enter both weight and height for BMI.", "error");
    (byId("weight") || byId("height")).focus();
    return;
  }

  if (report.spo2 && (Number(report.spo2) < 50 || Number(report.spo2) > 100)) {
    showMessage("newDataMessage", "SpO2 value must be between 50 and 100.", "error");
    byId("spo2").focus();
    return;
  }

  if (report.pulseRate && (Number(report.pulseRate) < 30 || Number(report.pulseRate) > 220)) {
    showMessage("newDataMessage", "Pulse rate must be between 30 and 220 BPM.", "error");
    byId("pulseRate").focus();
    return;
  }

  if (report.respRate && (Number(report.respRate) < 5 || Number(report.respRate) > 60)) {
    showMessage("newDataMessage", "Respiratory rate must be between 5 and 60.", "error");
    byId("respRate").focus();
    return;
  }

  if (report.bloodSugar && (Number(report.bloodSugar) < 20 || Number(report.bloodSugar) > 600)) {
    showMessage("newDataMessage", "Blood sugar must be between 20 and 600 mg/dL.", "error");
    byId("bloodSugar").focus();
    return;
  }

  if (report.painScore && (Number(report.painScore) < 0 || Number(report.painScore) > 10)) {
    showMessage("newDataMessage", "Pain score must be between 0 and 10.", "error");
    byId("painScore").focus();
    return;
  }

  if (report.weight && report.height) {
    const computedBmi = calculateBMI(report.weight, report.height);
    report.bmi = computedBmi;
    const bmiInput = byId("bmi");
    if (bmiInput) {
      bmiInput.value = computedBmi;
    }
  }

  report.triageRecommendation = recommendTriageLevel(report);
  const triageInput = byId("triageRecommendation");
  if (triageInput) {
    triageInput.value = report.triageRecommendation;
  }

  const priorityWeight = { Routine: 1, Urgent: 2, Emergency: 3 };
  let priorityAutoAdjusted = false;
  if ((priorityWeight[report.priority] || 0) < (priorityWeight[report.triageRecommendation] || 0)) {
    report.priority = report.triageRecommendation;
    priorityAutoAdjusted = true;
    const priorityInput = byId("priority");
    if (priorityInput) {
      priorityInput.value = report.priority;
    }
  }

  if (!report.doctor) {
    showMessage("newDataMessage", "Please enter doctor name/signature.", "error");
    byId("doctor").focus();
    return;
  }

  localStorage.setItem(STORAGE_KEYS.CURRENT_REPORT, JSON.stringify(report));

  preview.innerHTML = `
    <h3>Report Preview</h3>
    <p><strong>Patient:</strong> ${safeText(report.patientName)}</p>
    <p><strong>Age:</strong> ${safeText(report.patientAge || "-")}</p>
    <p><strong>Date:</strong> ${safeText(report.visitDate)}</p>
    <p><strong>Follow-up:</strong> ${safeText(report.followUpDate || "-")}</p>
    <p><strong>Priority:</strong> ${safeText(report.priority)}</p>
    <p><strong>Admission:</strong> ${safeText(report.admissionStatus || "Not Admitted")}</p>
    <p><strong>Disposition:</strong> ${safeText(report.disposition || "Home Care")}</p>
    <p><strong>Consultation:</strong> ${safeText(report.consultationType || "-")}</p>
    <p><strong>Complaint:</strong> ${safeText(report.chiefComplaint || "-")}</p>
    <p><strong>Complaint Duration:</strong> ${safeText(report.chiefComplaintDuration || "-")}</p>
    <p><strong>Pain Location:</strong> ${safeText(report.painLocation || "-")}</p>
    <p><strong>Allergies:</strong> ${safeText(report.knownAllergies || "-")}</p>
    <p><strong>Medication Adherence:</strong> ${safeText(report.medicationAdherence || "-")}</p>
    <p><strong>Comorbidities:</strong> ${safeText(report.comorbidities || "-")}</p>
    <p><strong>Pain/Oxygen:</strong> Pain ${safeText(report.painScore || "-")}/10, ${safeText(report.oxygenSupport || "Room Air")}</p>
    <p><strong>Vitals:</strong> Temp ${safeText(report.temperature || "-")}F, SpO2 ${safeText(report.spo2 || "-")}%, Weight ${safeText(report.weight || "-")}kg, Height ${safeText(report.height || "-")}cm, BMI ${safeText(report.bmi || "-")}, Pulse ${safeText(report.pulseRate || "-")} BPM, Resp ${safeText(report.respRate || "-")}/min, Sugar ${safeText(report.bloodSugar || "-")} mg/dL, BP ${safeText(report.bpSystolic || "-")}/${safeText(report.bpDiastolic || "-")}</p>
    <p><strong>Symptoms:</strong> ${safeText(report.symptoms)}</p>
    <p><strong>Diagnosis:</strong> ${safeText(report.diagnosis || "-")}</p>
    <p><strong>Medicines:</strong> ${safeText(report.medicines)}</p>
    <p><strong>Tests:</strong> ${safeText(report.tests)}</p>
    <p><strong>Care Plan:</strong> ${safeText(report.carePlan || "-")}</p>
    <p><strong>Risk:</strong> ${safeText(report.risk)}% (${safeText(report.riskLevel)})</p>
    <p><strong>AI Triage:</strong> ${safeText(report.triageRecommendation || "Routine")}</p>
    <p><strong>Doctor:</strong> ${safeText(report.doctor)}</p>
    <p><strong>Additional Notes:</strong> ${safeText(report.clinicalNotes || "-")}</p>
  `;

  after.hidden = false;
  if (priorityAutoAdjusted) {
    showMessage("newDataMessage", `Priority auto-updated to ${report.priority} based on AI triage.`);
    return;
  }
  showMessage("newDataMessage", "Report generated. You can now download or store it.");
}

function saveDraft() {
  const draft = {
    patientName: (byId("patientName") && byId("patientName").value.trim()) || "",
    patientAge: (byId("patientAge") && byId("patientAge").value.trim()) || "",
    visitDate: (byId("visitDate") && byId("visitDate").value) || "",
    followUpDate: (byId("followUpDate") && byId("followUpDate").value) || "",
    priority: (byId("priority") && byId("priority").value) || "Routine",
    admissionStatus: (byId("admissionStatus") && byId("admissionStatus").value) || "Not Admitted",
    disposition: (byId("disposition") && byId("disposition").value) || "Home Care",
    consultationType: (byId("consultationType") && byId("consultationType").value) || "In-person",
    chiefComplaint: (byId("chiefComplaint") && byId("chiefComplaint").value.trim()) || "",
    chiefComplaintDuration: (byId("chiefComplaintDuration") && byId("chiefComplaintDuration").value.trim()) || "",
    painLocation: (byId("painLocation") && byId("painLocation").value.trim()) || "",
    conversation: (byId("conversation") && byId("conversation").value.trim()) || "",
    knownAllergies: (byId("knownAllergies") && byId("knownAllergies").value.trim()) || "",
    medicationAdherence: (byId("medicationAdherence") && byId("medicationAdherence").value) || "Good",
    comorbidities: (byId("comorbidities") && byId("comorbidities").value.trim()) || "",
    painScore: (byId("painScore") && byId("painScore").value) || "",
    oxygenSupport: (byId("oxygenSupport") && byId("oxygenSupport").value) || "Room Air",
    temperature: (byId("temperature") && byId("temperature").value) || "",
    spo2: (byId("spo2") && byId("spo2").value) || "",
    weight: (byId("weight") && byId("weight").value) || "",
    height: (byId("height") && byId("height").value) || "",
    bmi: (byId("bmi") && byId("bmi").value) || "",
    pulseRate: (byId("pulseRate") && byId("pulseRate").value) || "",
    respRate: (byId("respRate") && byId("respRate").value) || "",
    bloodSugar: (byId("bloodSugar") && byId("bloodSugar").value) || "",
    bpSystolic: (byId("bpSystolic") && byId("bpSystolic").value) || "",
    bpDiastolic: (byId("bpDiastolic") && byId("bpDiastolic").value) || "",
    symptoms: (byId("symptoms") && byId("symptoms").value.trim()) || "",
    diagnosis: (byId("diagnosis") && byId("diagnosis").value.trim()) || "",
    medicines: (byId("medicines") && byId("medicines").value.trim()) || "",
    tests: (byId("tests") && byId("tests").value.trim()) || "",
    carePlan: (byId("carePlan") && byId("carePlan").value.trim()) || "",
    clinicalNotes: (byId("clinicalNotes") && byId("clinicalNotes").value.trim()) || "",
    doctor: (byId("doctor") && byId("doctor").value.trim()) || "",
    risk: Number((byId("risk") && byId("risk").innerText) || 0),
    triageRecommendation: (byId("triageRecommendation") && byId("triageRecommendation").value) || "Routine"
  };

  setStoredJSON(STORAGE_KEYS.DRAFT_REPORT, draft);
  showMessage("newDataMessage", "Draft saved locally.");
}

function resetNewDataForm() {
  [
    "patientName",
    "chiefComplaint",
    "chiefComplaintDuration",
    "painLocation",
    "followUpDate",
    "conversation",
    "knownAllergies",
    "comorbidities",
    "disposition",
    "painScore",
    "oxygenSupport",
    "temperature",
    "spo2",
    "weight",
    "height",
    "bmi",
    "pulseRate",
    "respRate",
    "bloodSugar",
    "bpSystolic",
    "bpDiastolic",
    "symptoms",
    "diagnosis",
    "medicines",
    "tests",
    "carePlan",
    "clinicalNotes",
    "doctor",
    "triageRecommendation"
  ].forEach((id) => {
    const field = byId(id);
    if (field) {
      field.value = "";
    }
  });

  const risk = byId("risk");
  const riskLevel = byId("riskLevel");
  const preview = byId("preview");
  const after = byId("after");
  const priority = byId("priority");
  const admissionStatus = byId("admissionStatus");
  const disposition = byId("disposition");
  const consultationType = byId("consultationType");
  const oxygenSupport = byId("oxygenSupport");
  const medicationAdherence = byId("medicationAdherence");
  const patientAge = byId("patientAge");

  if (risk) {
    risk.innerText = "0";
  }

  if (riskLevel) {
    riskLevel.innerText = "Low";
  }

  if (preview) {
    preview.innerHTML = "";
  }

  if (after) {
    after.hidden = true;
  }

  if (priority) {
    priority.value = "Routine";
  }

  if (admissionStatus) {
    admissionStatus.value = "Not Admitted";
  }

  if (disposition) {
    disposition.value = "Home Care";
  }

  if (consultationType) {
    consultationType.value = "In-person";
  }

  if (oxygenSupport) {
    oxygenSupport.value = "Room Air";
  }

  if (medicationAdherence) {
    medicationAdherence.value = "Good";
  }

  if (patientAge) {
    patientAge.value = calculateAgeFromDOB(localStorage.getItem(STORAGE_KEYS.DOB) || "");
  }

  updateBMIField();
  updateTriageRecommendationField();

  localStorage.removeItem(STORAGE_KEYS.CURRENT_REPORT);
  showMessage("newDataMessage", "Form reset complete.");
  applyDateLimits();
}

function sendPharmacy() {
  showMessage("newDataMessage", "Patient report flagged for pharmacy follow-up.");
}

function sendLab() {
  showMessage("newDataMessage", "Patient report flagged for laboratory follow-up.");
}

async function storeReport() {
  const current = getStoredJSON(STORAGE_KEYS.CURRENT_REPORT, null);
  if (!current) {
    showMessage("newDataMessage", "Please generate a report before storing.", "error");
    return;
  }

  const reports = getStoredJSON(STORAGE_KEYS.REPORTS, []);

  const duplicateIndex = reports.findIndex((item) => item.id === current.id);
  if (duplicateIndex >= 0) {
    reports[duplicateIndex] = current;
  } else {
    reports.push(current);
  }

  setStoredJSON(STORAGE_KEYS.REPORTS, reports);
  localStorage.removeItem(STORAGE_KEYS.CURRENT_REPORT);
  localStorage.removeItem(STORAGE_KEYS.DRAFT_REPORT);

  const response = await apiRequest("/reports", {
    method: "POST",
    body: JSON.stringify(current)
  });

  if (!response.ok) {
    showMessage("newDataMessage", `Report saved locally. Server sync failed: ${response.message}`, "error");
  }

  updateDashboardStats();
  if (response.ok) {
    showMessage("newDataMessage", "Report stored successfully.");
  }
}

function formatFileName(name) {
  return String(name || "Medical_Report")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 40) || "Medical_Report";
}

function downloadPDF(index) {
  let data = null;

  if (typeof index === "number") {
    const reports = getStoredJSON(STORAGE_KEYS.REPORTS, []);
    data = reports[index] || null;
  } else {
    data = getStoredJSON(STORAGE_KEYS.CURRENT_REPORT, null);
  }

  if (!data) {
    showMessage("newDataMessage", "Report not found.", "error");
    return;
  }

  const patientName = getReportField(data, ["patientName", "name"], "Medical_Report");
  const patientAge = getReportField(data, ["patientAge"], "-");
  const visitDate = getReportField(data, ["visitDate", "date"]);
  const followUpDate = getReportField(data, ["followUpDate"], "-");
  const priority = getReportField(data, ["priority"], "Routine");
  const admissionStatus = getReportField(data, ["admissionStatus"], "Not Admitted");
  const disposition = getReportField(data, ["disposition"], "Home Care");
  const consultationType = getReportField(data, ["consultationType"], "In-person");
  const chiefComplaint = getReportField(data, ["chiefComplaint"], "-");
  const chiefComplaintDuration = getReportField(data, ["chiefComplaintDuration"], "-");
  const painLocation = getReportField(data, ["painLocation"], "-");
  const knownAllergies = getReportField(data, ["knownAllergies"], "-");
  const medicationAdherence = getReportField(data, ["medicationAdherence"], "-");
  const comorbidities = getReportField(data, ["comorbidities"], "-");
  const painScore = getReportField(data, ["painScore"], "-");
  const oxygenSupport = getReportField(data, ["oxygenSupport"], "Room Air");
  const temperature = getReportField(data, ["temperature"], "-");
  const spo2 = getReportField(data, ["spo2"], "-");
  const weight = getReportField(data, ["weight"], "-");
  const height = getReportField(data, ["height"], "-");
  const bmi = getReportField(data, ["bmi"], calculateBMI(weight, height) || "-");
  const pulseRate = getReportField(data, ["pulseRate"], "-");
  const respRate = getReportField(data, ["respRate"], "-");
  const bloodSugar = getReportField(data, ["bloodSugar"], "-");
  const bpSystolic = getReportField(data, ["bpSystolic"], "-");
  const bpDiastolic = getReportField(data, ["bpDiastolic"], "-");
  const status = getReportField(data, ["status"], "N/A");
  const symptoms = getReportField(data, ["symptoms"]);
  const diagnosis = getReportField(data, ["diagnosis"], "-");
  const medicines = getReportField(data, ["medicines"]);
  const tests = getReportField(data, ["tests", "exercise"]);
  const carePlan = getReportField(data, ["carePlan"], "-");
  const risk = getReportField(data, ["risk"], "0");
  const riskLevel = getReportField(data, ["riskLevel"], getRiskLevel(Number(risk) || 0));
  const triageRecommendation = getReportField(data, ["triageRecommendation", "priority"], "Routine");
  const doctor = getReportField(data, ["doctor"]);
  const notes = getReportField(data, ["clinicalNotes"], "-");

  let text = "CAREJR AI MEDICAL REPORT\n\n";
  text += `Patient: ${patientName}\n`;
  text += `Age: ${patientAge}\n`;
  text += `Date: ${visitDate}\n`;
  text += `Follow-up Date: ${followUpDate}\n`;
  text += `Priority: ${priority}\n`;
  text += `Admission Status: ${admissionStatus}\n`;
  text += `Disposition: ${disposition}\n`;
  text += `Consultation Type: ${consultationType}\n`;
  text += `Chief Complaint: ${chiefComplaint}\n`;
  text += `Complaint Duration: ${chiefComplaintDuration}\n`;
  text += `Pain Location: ${painLocation}\n`;
  text += `Known Allergies: ${knownAllergies}\n`;
  text += `Medication Adherence: ${medicationAdherence}\n`;
  text += `Comorbidities: ${comorbidities}\n`;
  text += `Pain/Oxygen: Pain ${painScore}/10, ${oxygenSupport}\n`;
  text += `Vitals: Temp ${temperature}F, SpO2 ${spo2}%, Weight ${weight}kg, Height ${height}cm, BMI ${bmi}, Pulse ${pulseRate} BPM, Resp ${respRate}/min, Sugar ${bloodSugar} mg/dL, BP ${bpSystolic}/${bpDiastolic}\n`;
  text += `Status: ${status}\n`;
  text += `Symptoms: ${symptoms}\n`;
  text += `Diagnosis: ${diagnosis}\n`;
  text += `Medicines: ${medicines}\n`;
  text += `Tests: ${tests}\n`;
  text += `Care Plan: ${carePlan}\n`;
  text += `Risk: ${risk}% (${riskLevel})\n`;
  text += `AI Triage: ${triageRecommendation}\n`;
  text += `Doctor: ${doctor}\n`;
  text += `Additional Notes: ${notes}`;

  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `${formatFileName(patientName)}_report.txt`;
  link.click();

  URL.revokeObjectURL(url);
}

function matchesFilters(report) {
  const searchInput = byId("searchReport");
  const highRiskOnly = byId("highRiskOnly");
  const comorbidityOnly = byId("comorbidityOnly");
  const priorityMismatchOnly = byId("priorityMismatchOnly");
  const priorityFilter = byId("priorityFilter");
  const triageFilter = byId("triageFilter");
  const admissionFilter = byId("admissionFilter");
  const consultationFilter = byId("consultationFilter");
  const followUpFilter = byId("followUpFilter");

  const search = searchInput ? searchInput.value.trim().toLowerCase() : "";
  const highRisk = highRiskOnly ? highRiskOnly.checked : false;
  const onlyComorbidity = comorbidityOnly ? comorbidityOnly.checked : false;
  const onlyPriorityMismatch = priorityMismatchOnly ? priorityMismatchOnly.checked : false;
  const prioritySelected = priorityFilter ? priorityFilter.value : "all";
  const triageSelected = triageFilter ? triageFilter.value : "all";
  const admissionSelected = admissionFilter ? admissionFilter.value : "all";
  const consultationSelected = consultationFilter ? consultationFilter.value : "all";
  const followUpSelected = followUpFilter ? followUpFilter.value : "all";

  const patient = String(getReportField(report, ["patientName", "name"], "")).toLowerCase();
  const complaint = String(getReportField(report, ["chiefComplaint"], "")).toLowerCase();
  const complaintDuration = String(getReportField(report, ["chiefComplaintDuration"], "")).toLowerCase();
  const painLocation = String(getReportField(report, ["painLocation"], "")).toLowerCase();
  const symptoms = String(getReportField(report, ["symptoms"], "")).toLowerCase();
  const diagnosis = String(getReportField(report, ["diagnosis"], "")).toLowerCase();
  const doctor = String(getReportField(report, ["doctor"], "")).toLowerCase();
  const tests = String(getReportField(report, ["tests"], "")).toLowerCase();
  const pain = String(getReportField(report, ["painScore"], "")).toLowerCase();
  const adherence = String(getReportField(report, ["medicationAdherence"], "")).toLowerCase();
  const oxygen = String(getReportField(report, ["oxygenSupport"], "")).toLowerCase();
  const comorbidities = String(getReportField(report, ["comorbidities"], "")).toLowerCase();
  const admission = String(getReportField(report, ["admissionStatus"], "Not Admitted")).toLowerCase();
  const disposition = String(getReportField(report, ["disposition"], "Home Care")).toLowerCase();
  const consultationType = String(getReportField(report, ["consultationType"], "In-person")).toLowerCase();
  const priority = String(getPriorityFromReport(report)).toLowerCase();
  const triage = String(getTriageFromReport(report)).toLowerCase();
  const followUpStatus = getFollowUpStatus(report).toLowerCase();
  const notes = String(getReportField(report, ["clinicalNotes"], "")).toLowerCase();
  const risk = Number(getReportField(report, ["risk"], 0)) || 0;

  if (highRisk && risk < 70) {
    return false;
  }

  if (onlyComorbidity && !String(getReportField(report, ["comorbidities"], "")).trim()) {
    return false;
  }

  if (onlyPriorityMismatch && !hasPriorityMismatch(report)) {
    return false;
  }

  if (prioritySelected !== "all" && getPriorityFromReport(report) !== prioritySelected) {
    return false;
  }

  if (triageSelected !== "all" && getTriageFromReport(report) !== triageSelected) {
    return false;
  }

  if (admissionSelected !== "all" && getReportField(report, ["admissionStatus"], "Not Admitted") !== admissionSelected) {
    return false;
  }

  if (consultationSelected !== "all" && getReportField(report, ["consultationType"], "In-person") !== consultationSelected) {
    return false;
  }

  if (followUpSelected === "due" && !["due today", "overdue"].includes(followUpStatus)) {
    return false;
  }

  if (followUpSelected === "today" && followUpStatus !== "due today") {
    return false;
  }

  if (followUpSelected === "overdue" && followUpStatus !== "overdue") {
    return false;
  }

  if (followUpSelected === "scheduled" && followUpStatus !== "scheduled") {
    return false;
  }

  if (followUpSelected === "none" && followUpStatus !== "not set") {
    return false;
  }

  if (search) {
    const haystack = `${patient} ${complaint} ${complaintDuration} ${painLocation} ${symptoms} ${diagnosis} ${doctor} ${tests} ${pain} ${adherence} ${oxygen} ${comorbidities} ${admission} ${disposition} ${consultationType} ${priority} ${triage} ${followUpStatus} ${notes}`;
    if (!haystack.includes(search)) {
      return false;
    }
  }

  return true;
}

function riskBadgeClass(risk) {
  if (risk >= 80) {
    return "risk-critical";
  }
  if (risk >= 60) {
    return "risk-high";
  }
  if (risk >= 30) {
    return "risk-moderate";
  }
  return "risk-low";
}

function parseReportDate(report) {
  const rawDate = getReportField(report, ["createdAt", "visitDate", "date"], "");
  const parsed = Date.parse(rawDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseReportRisk(report) {
  return Number(getReportField(report, ["risk"], 0)) || 0;
}

const PRIORITY_WEIGHT = {
  Emergency: 3,
  Urgent: 2,
  Routine: 1
};

function normalizePriority(value) {
  const priority = String(value || "").trim();
  if (priority === "Emergency" || priority === "Urgent" || priority === "Routine") {
    return priority;
  }
  return "Routine";
}

function getPriorityWeight(value) {
  return PRIORITY_WEIGHT[normalizePriority(value)] || PRIORITY_WEIGHT.Routine;
}

function getPriorityFromReport(report) {
  return normalizePriority(getReportField(report, ["priority"], "Routine"));
}

function getTriageFromReport(report) {
  return normalizePriority(getReportField(report, ["triageRecommendation", "priority"], "Routine"));
}

function hasPriorityMismatch(report) {
  return getPriorityWeight(getPriorityFromReport(report)) < getPriorityWeight(getTriageFromReport(report));
}

function getTodayIsoDate() {
  return new Date().toISOString().split("T")[0];
}

function getFollowUpStatus(report, today = getTodayIsoDate()) {
  const followUp = String(getReportField(report, ["followUpDate"], "")).trim();
  if (!followUp) {
    return "Not Set";
  }
  if (followUp < today) {
    return "Overdue";
  }
  if (followUp === today) {
    return "Due Today";
  }
  return "Scheduled";
}

function followUpBadgeClass(status) {
  if (status === "Overdue") {
    return "followup-overdue";
  }
  if (status === "Due Today") {
    return "followup-due";
  }
  if (status === "Scheduled") {
    return "followup-scheduled";
  }
  return "followup-none";
}

function sortReportEntries(entries) {
  const sortSelect = byId("sortReports");
  const sortMode = sortSelect ? sortSelect.value : "newest";
  const list = entries.slice();

  if (sortMode === "oldest") {
    list.sort((a, b) => parseReportDate(a.report) - parseReportDate(b.report));
  } else if (sortMode === "risk-high") {
    list.sort((a, b) => parseReportRisk(b.report) - parseReportRisk(a.report));
  } else if (sortMode === "risk-low") {
    list.sort((a, b) => parseReportRisk(a.report) - parseReportRisk(b.report));
  } else if (sortMode === "priority") {
    list.sort((a, b) => {
      const aPriority = getPriorityFromReport(a.report);
      const bPriority = getPriorityFromReport(b.report);
      return getPriorityWeight(bPriority) - getPriorityWeight(aPriority);
    });
  } else {
    list.sort((a, b) => parseReportDate(b.report) - parseReportDate(a.report));
  }

  return list;
}

function getFilteredReportEntries(reports) {
  return sortReportEntries(
    reports
      .map((report, index) => ({ report, index }))
      .filter(({ report }) => matchesFilters(report))
  );
}

function updatePreviousSummary(filteredEntries, totalStored) {
  const visible = filteredEntries.length;
  const visibleRisks = filteredEntries.map((entry) => parseReportRisk(entry.report));
  const critical = visibleRisks.filter((risk) => risk >= 80).length;
  const emergencyPriority = filteredEntries.filter(
    (entry) => getPriorityFromReport(entry.report) === "Emergency"
  ).length;
  const urgentPriority = filteredEntries.filter(
    (entry) => getPriorityFromReport(entry.report) === "Urgent"
  ).length;
  const routinePriority = filteredEntries.filter(
    (entry) => getPriorityFromReport(entry.report) === "Routine"
  ).length;
  const needsAttention = filteredEntries.filter((entry) => {
    const triage = getTriageFromReport(entry.report);
    return triage === "Urgent" || triage === "Emergency";
  }).length;
  const priorityMismatch = filteredEntries.filter((entry) => hasPriorityMismatch(entry.report)).length;
  const icuCases = filteredEntries.filter(
    (entry) => getReportField(entry.report, ["admissionStatus"], "Not Admitted") === "ICU"
  ).length;
  const comorbidityCases = filteredEntries.filter(
    (entry) => String(getReportField(entry.report, ["comorbidities"], "")).trim() !== ""
  ).length;
  const today = getTodayIsoDate();
  const followUpDue = filteredEntries.filter((entry) => {
    const status = getFollowUpStatus(entry.report, today);
    return status === "Due Today" || status === "Overdue";
  }).length;
  const followUpOverdue = filteredEntries.filter((entry) => {
    return getFollowUpStatus(entry.report, today) === "Overdue";
  }).length;
  const followUpScheduled = filteredEntries.filter((entry) => {
    return getFollowUpStatus(entry.report, today) === "Scheduled";
  }).length;
  const noFollowUp = filteredEntries.filter((entry) => {
    return getFollowUpStatus(entry.report, today) === "Not Set";
  }).length;
  const followUpOnTrack = Math.max(visible - followUpOverdue, 0);
  const alignedPriority = Math.max(visible - priorityMismatch, 0);
  const painValues = filteredEntries
    .map((entry) => String(getReportField(entry.report, ["painScore"], "")).trim())
    .filter((value) => value !== "")
    .map((value) => Number(value))
    .filter((pain) => Number.isFinite(pain) && pain >= 0);
  const highPainCases = filteredEntries.filter((entry) => {
    const pain = Number(getReportField(entry.report, ["painScore"], 0));
    return Number.isFinite(pain) && pain >= 7;
  }).length;
  const icuTransferCases = filteredEntries.filter(
    (entry) => getReportField(entry.report, ["disposition"], "Home Care") === "ICU Transfer"
  ).length;
  const avgPain = painValues.length > 0
    ? (painValues.reduce((sum, pain) => sum + pain, 0) / painValues.length).toFixed(1)
    : "0";
  const avgRisk = visible > 0
    ? Math.round(visibleRisks.reduce((sum, risk) => sum + risk, 0) / visible)
    : 0;

  const summaryVisible = byId("summaryVisible");
  const summaryStored = byId("summaryStored");
  const summaryCritical = byId("summaryCritical");
  const summaryEmergency = byId("summaryEmergency");
  const summaryUrgent = byId("summaryUrgent");
  const summaryRoutine = byId("summaryRoutine");
  const summaryFollowUpDue = byId("summaryFollowUpDue");
  const summaryFollowUpOnTrack = byId("summaryFollowUpOnTrack");
  const summaryFollowUpOverdue = byId("summaryFollowUpOverdue");
  const summaryFollowUpScheduled = byId("summaryFollowUpScheduled");
  const summaryNoFollowUp = byId("summaryNoFollowUp");
  const summaryNeedsAttention = byId("summaryNeedsAttention");
  const summaryPriorityMismatch = byId("summaryPriorityMismatch");
  const summaryAligned = byId("summaryAligned");
  const summaryICU = byId("summaryICU");
  const summaryHighPain = byId("summaryHighPain");
  const summaryIcuTransfer = byId("summaryIcuTransfer");
  const summaryComorbidity = byId("summaryComorbidity");
  const summaryAveragePain = byId("summaryAveragePain");
  const summaryAverage = byId("summaryAverage");

  if (summaryVisible) {
    summaryVisible.textContent = String(visible);
  }
  if (summaryStored) {
    summaryStored.textContent = String(totalStored);
  }
  if (summaryCritical) {
    summaryCritical.textContent = String(critical);
  }
  if (summaryEmergency) {
    summaryEmergency.textContent = String(emergencyPriority);
  }
  if (summaryUrgent) {
    summaryUrgent.textContent = String(urgentPriority);
  }
  if (summaryRoutine) {
    summaryRoutine.textContent = String(routinePriority);
  }
  if (summaryFollowUpDue) {
    summaryFollowUpDue.textContent = String(followUpDue);
  }
  if (summaryFollowUpOnTrack) {
    summaryFollowUpOnTrack.textContent = String(followUpOnTrack);
  }
  if (summaryFollowUpOverdue) {
    summaryFollowUpOverdue.textContent = String(followUpOverdue);
  }
  if (summaryFollowUpScheduled) {
    summaryFollowUpScheduled.textContent = String(followUpScheduled);
  }
  if (summaryNoFollowUp) {
    summaryNoFollowUp.textContent = String(noFollowUp);
  }
  if (summaryNeedsAttention) {
    summaryNeedsAttention.textContent = String(needsAttention);
  }
  if (summaryPriorityMismatch) {
    summaryPriorityMismatch.textContent = String(priorityMismatch);
  }
  if (summaryAligned) {
    summaryAligned.textContent = String(alignedPriority);
  }
  if (summaryICU) {
    summaryICU.textContent = String(icuCases);
  }
  if (summaryHighPain) {
    summaryHighPain.textContent = String(highPainCases);
  }
  if (summaryIcuTransfer) {
    summaryIcuTransfer.textContent = String(icuTransferCases);
  }
  if (summaryComorbidity) {
    summaryComorbidity.textContent = String(comorbidityCases);
  }
  if (summaryAveragePain) {
    summaryAveragePain.textContent = avgPain;
  }
  if (summaryAverage) {
    summaryAverage.textContent = `${avgRisk}%`;
  }
}

function loadReports() {
  const container = byId("reportContainer");
  if (!container) {
    return;
  }

  const reports = getStoredJSON(STORAGE_KEYS.REPORTS, []);
  container.innerHTML = "";
  updatePreviousSummary([], reports.length);

  if (reports.length === 0) {
    container.innerHTML = '<div class="no-report">No Reports Available</div>';
    showMessage("reportsMessage", "No report data found yet.", "error");
    return;
  }

  const sortedEntries = getFilteredReportEntries(reports);
  updatePreviousSummary(sortedEntries, reports.length);

  if (sortedEntries.length === 0) {
    container.innerHTML = '<div class="no-report">No reports match current filters.</div>';
    showMessage("reportsMessage", "No matching reports.", "error");
    return;
  }

  sortedEntries.forEach(({ report, index }) => {
    const patient = getReportField(report, ["patientName", "name"]);
    const patientAge = getReportField(report, ["patientAge"], "-");
    const date = getReportField(report, ["visitDate", "date"]);
    const followUpDate = getReportField(report, ["followUpDate"], "-");
    const priority = getPriorityFromReport(report);
    const admissionStatus = getReportField(report, ["admissionStatus"], "Not Admitted");
    const disposition = getReportField(report, ["disposition"], "Home Care");
    const consultationType = getReportField(report, ["consultationType"], "In-person");
    const complaint = getReportField(report, ["chiefComplaint"], "-");
    const complaintDuration = getReportField(report, ["chiefComplaintDuration"], "-");
    const painLocation = getReportField(report, ["painLocation"], "-");
    const allergies = getReportField(report, ["knownAllergies"], "-");
    const medicationAdherence = getReportField(report, ["medicationAdherence"], "-");
    const comorbidities = getReportField(report, ["comorbidities"], "-");
    const painScore = getReportField(report, ["painScore"], "-");
    const oxygenSupport = getReportField(report, ["oxygenSupport"], "Room Air");
    const temperature = getReportField(report, ["temperature"], "-");
    const spo2 = getReportField(report, ["spo2"], "-");
    const weight = getReportField(report, ["weight"], "-");
    const height = getReportField(report, ["height"], "-");
    const bmi = getReportField(report, ["bmi"], calculateBMI(weight, height) || "-");
    const pulseRate = getReportField(report, ["pulseRate"], "-");
    const respRate = getReportField(report, ["respRate"], "-");
    const bloodSugar = getReportField(report, ["bloodSugar"], "-");
    const bpSystolic = getReportField(report, ["bpSystolic"], "-");
    const bpDiastolic = getReportField(report, ["bpDiastolic"], "-");
    const status = getReportField(report, ["status"]);
    const symptoms = getReportField(report, ["symptoms"]);
    const diagnosis = getReportField(report, ["diagnosis"], "-");
    const medicines = getReportField(report, ["medicines"]);
    const tests = getReportField(report, ["tests", "exercise"]);
    const carePlan = getReportField(report, ["carePlan"], "-");
    const risk = parseReportRisk(report);
    const riskLevel = getReportField(report, ["riskLevel"], getRiskLevel(risk));
    const triageRecommendation = getTriageFromReport(report);
    const followUpStatus = getFollowUpStatus(report);
    const priorityMismatch = hasPriorityMismatch(report);
    const doctor = getReportField(report, ["doctor"]);
    const notes = getReportField(report, ["clinicalNotes"], "-");
    const reportId = getReportField(report, ["id"], "");

    const div = document.createElement("div");
    div.className = "report";

    div.innerHTML = `
      <h3>${safeText(patient)}</h3>
      <p><strong>Age:</strong> ${safeText(patientAge)}</p>
      <p><strong>Date:</strong> ${safeText(date)}</p>
      <p><strong>Follow-up:</strong> ${safeText(followUpDate)}</p>
      <p><strong>Follow-up Status:</strong> <span class="followup-badge ${followUpBadgeClass(followUpStatus)}">${safeText(followUpStatus)}</span></p>
      <p><strong>Priority:</strong> ${safeText(priority)}</p>
      <p><strong>Admission:</strong> ${safeText(admissionStatus)}</p>
      <p><strong>Disposition:</strong> ${safeText(disposition)}</p>
      <p><strong>Consultation:</strong> ${safeText(consultationType)}</p>
      <p><strong>Complaint:</strong> ${safeText(complaint)}</p>
      <p><strong>Complaint Duration:</strong> ${safeText(complaintDuration)}</p>
      <p><strong>Pain Location:</strong> ${safeText(painLocation)}</p>
      <p><strong>Allergies:</strong> ${safeText(allergies)}</p>
      <p><strong>Medication Adherence:</strong> ${safeText(medicationAdherence)}</p>
      <p><strong>Comorbidities:</strong> ${safeText(comorbidities)}</p>
      <p><strong>Pain/Oxygen:</strong> Pain ${safeText(painScore)}/10, ${safeText(oxygenSupport)}</p>
      <p><strong>Vitals:</strong> Temp ${safeText(temperature)}F, SpO2 ${safeText(spo2)}%, Weight ${safeText(weight)}kg, Height ${safeText(height)}cm, BMI ${safeText(bmi)}, Pulse ${safeText(pulseRate)} BPM, Resp ${safeText(respRate)}/min, Sugar ${safeText(bloodSugar)} mg/dL, BP ${safeText(bpSystolic)}/${safeText(bpDiastolic)}</p>
      <p><strong>Status:</strong> ${safeText(status)}</p>
      <p><strong>Symptoms:</strong> ${safeText(symptoms)}</p>
      <p><strong>Diagnosis:</strong> ${safeText(diagnosis)}</p>
      <p><strong>Medicines:</strong> ${safeText(medicines)}</p>
      <p><strong>Tests:</strong> ${safeText(tests)}</p>
      <p><strong>Care Plan:</strong> ${safeText(carePlan)}</p>
      <p><strong>Risk:</strong> <span class="risk-badge ${riskBadgeClass(risk)}">${safeText(risk)}% (${safeText(riskLevel)})</span></p>
      <p><strong>AI Triage:</strong> ${safeText(triageRecommendation)}</p>
      <p><strong>Priority Match:</strong> <span class="mismatch-badge ${priorityMismatch ? "mismatch-yes" : "mismatch-no"}">${priorityMismatch ? `Mismatch (AI: ${safeText(triageRecommendation)})` : "Aligned"}</span></p>
      <p><strong>Doctor:</strong> ${safeText(doctor)}</p>
      <p><strong>Notes:</strong> ${safeText(notes)}</p>
      <div class="report-actions">
        <button class="pdf-btn" onclick="downloadPDF(${index})">Download Report</button>
        <button class="delete-btn" onclick="deleteReport(${index}, '${safeText(reportId)}')">Delete</button>
      </div>
    `;

    container.appendChild(div);
  });

  showMessage("reportsMessage", `${sortedEntries.length} report(s) shown.`);
}

function filterReports() {
  loadReports();
}

function exportAllReports() {
  const reports = getStoredJSON(STORAGE_KEYS.REPORTS, []);
  if (reports.length === 0) {
    showMessage("reportsMessage", "No reports available to export.", "error");
    return;
  }

  const payload = JSON.stringify(reports, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `carejr_reports_${new Date().toISOString().slice(0, 10)}.json`;
  link.click();

  URL.revokeObjectURL(url);
  showMessage("reportsMessage", "All reports exported.");
}

function exportFilteredReports() {
  const reports = getStoredJSON(STORAGE_KEYS.REPORTS, []);
  if (reports.length === 0) {
    showMessage("reportsMessage", "No reports available to export.", "error");
    return;
  }

  const visibleEntries = getFilteredReportEntries(reports);
  if (visibleEntries.length === 0) {
    showMessage("reportsMessage", "No visible reports to export.", "error");
    return;
  }

  const visibleReports = visibleEntries.map((entry) => entry.report);
  const payload = JSON.stringify(visibleReports, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `carejr_reports_visible_${new Date().toISOString().slice(0, 10)}.json`;
  link.click();

  URL.revokeObjectURL(url);
  showMessage("reportsMessage", `${visibleReports.length} visible report(s) exported.`);
}

async function clearReports() {
  const reports = getStoredJSON(STORAGE_KEYS.REPORTS, []);
  if (reports.length === 0) {
    showMessage("reportsMessage", "No reports to clear.", "error");
    return;
  }

  const shouldClear = window.confirm("Clear all stored reports?");
  if (!shouldClear) {
    return;
  }

  const response = await apiRequest("/reports", { method: "DELETE" });
  if (!response.ok) {
    showMessage("reportsMessage", response.message, "error");
    return;
  }

  localStorage.removeItem(STORAGE_KEYS.REPORTS);
  loadReports();
  updateDashboardStats();
  showMessage("reportsMessage", "All reports cleared.");
}

async function deleteReport(index, id) {
  const reports = getStoredJSON(STORAGE_KEYS.REPORTS, []);
  let targetIndex = Number.isInteger(index) ? index : -1;

  if (targetIndex < 0 && id) {
    targetIndex = reports.findIndex((report) => String(report.id) === String(id));
  }

  if (targetIndex < 0) {
    return;
  }

  const shouldDelete = window.confirm("Delete this report?");
  if (!shouldDelete) {
    return;
  }

  const target = reports[targetIndex];
  const reportId = id || (target && target.id);
  if (!reportId) {
    showMessage("reportsMessage", "Report id missing. Cannot delete from server.", "error");
    return;
  }

  const response = await apiRequest(`/reports/${encodeURIComponent(reportId)}`, { method: "DELETE" });
  if (!response.ok) {
    showMessage("reportsMessage", response.message, "error");
    return;
  }

  reports.splice(targetIndex, 1);
  setStoredJSON(STORAGE_KEYS.REPORTS, reports);
  loadReports();
  updateDashboardStats();
}

function updateDashboardStats() {
  const reports = getStoredJSON(STORAGE_KEYS.REPORTS, []);

  const total = reports.length;
  const highRisk = reports.filter((report) => parseReportRisk(report) >= 70).length;
  const critical = reports.filter((report) => parseReportRisk(report) >= 80).length;
  const high = reports.filter((report) => parseReportRisk(report) >= 60 && parseReportRisk(report) < 80).length;
  const moderate = reports.filter((report) => parseReportRisk(report) >= 30 && parseReportRisk(report) < 60).length;
  const low = reports.filter((report) => parseReportRisk(report) < 30).length;
  const average = total > 0
    ? Math.round(reports.reduce((sum, report) => sum + parseReportRisk(report), 0) / total)
    : 0;
  const today = getTodayIsoDate();
  const routineCount = reports.filter((report) => getPriorityFromReport(report) === "Routine").length;
  const urgentCount = reports.filter((report) => getPriorityFromReport(report) === "Urgent").length;
  const emergencyCount = reports.filter((report) => getPriorityFromReport(report) === "Emergency").length;
  const triageEmergencyCount = reports.filter(
    (report) => getTriageFromReport(report) === "Emergency"
  ).length;
  const needsAttentionCount = reports.filter((report) => {
    const triage = getTriageFromReport(report);
    return triage === "Urgent" || triage === "Emergency";
  }).length;
  const priorityMismatchCount = reports.filter((report) => hasPriorityMismatch(report)).length;
  const priorityAlignedCount = Math.max(total - priorityMismatchCount, 0);
  const reportsToday = reports.filter(
    (report) => getReportField(report, ["visitDate", "date"], "") === today
  ).length;
  const followUpDue = reports.filter((report) => {
    const status = getFollowUpStatus(report, today);
    return status === "Due Today" || status === "Overdue";
  }).length;
  const followUpToday = reports.filter(
    (report) => getFollowUpStatus(report, today) === "Due Today"
  ).length;
  const followUpOverdue = reports.filter((report) => {
    return getFollowUpStatus(report, today) === "Overdue";
  }).length;
  const followUpScheduled = reports.filter((report) => {
    return getFollowUpStatus(report, today) === "Scheduled";
  }).length;
  const noFollowUp = reports.filter((report) => {
    return getFollowUpStatus(report, today) === "Not Set";
  }).length;
  const followUpOnTrack = Math.max(total - followUpOverdue, 0);
  const admittedCases = reports.filter((report) => {
    const admissionStatus = getReportField(report, ["admissionStatus"], "Not Admitted");
    return admissionStatus === "Observation" || admissionStatus === "Admitted" || admissionStatus === "ICU";
  }).length;
  const icuCases = reports.filter(
    (report) => getReportField(report, ["admissionStatus"], "Not Admitted") === "ICU"
  ).length;
  const comorbidityCases = reports.filter(
    (report) => String(getReportField(report, ["comorbidities"], "")).trim() !== ""
  ).length;
  const highPainCases = reports.filter((report) => {
    const pain = Number(getReportField(report, ["painScore"], 0));
    return Number.isFinite(pain) && pain >= 7;
  }).length;
  const teleConsultCases = reports.filter(
    (report) => getReportField(report, ["consultationType"], "In-person") === "Tele-consult"
  ).length;
  const icuTransferCases = reports.filter(
    (report) => getReportField(report, ["disposition"], "Home Care") === "ICU Transfer"
  ).length;
  const painValues = reports
    .map((report) => String(getReportField(report, ["painScore"], "")).trim())
    .filter((value) => value !== "")
    .map((value) => Number(value))
    .filter((pain) => Number.isFinite(pain) && pain >= 0 && pain <= 10);
  const averagePain = painValues.length > 0
    ? (painValues.reduce((sum, pain) => sum + pain, 0) / painValues.length).toFixed(1)
    : "0";

  let lastVisit = "-";
  if (reports.length > 0) {
    const sorted = reports
      .map((report) => getReportField(report, ["visitDate", "date"], ""))
      .filter(Boolean)
      .sort();
    const latest = sorted[sorted.length - 1];
    if (latest) {
      lastVisit = latest;
    }
  }

  const statTotal = byId("statTotal");
  const statHighRisk = byId("statHighRisk");
  const statCritical = byId("statCritical");
  const statModerate = byId("statModerate");
  const statLow = byId("statLow");
  const statAverage = byId("statAverage");
  const statRoutine = byId("statRoutine");
  const statUrgent = byId("statUrgent");
  const statEmergency = byId("statEmergency");
  const statToday = byId("statToday");
  const statFollowUpDue = byId("statFollowUpDue");
  const statFollowUpToday = byId("statFollowUpToday");
  const statFollowUpOverdue = byId("statFollowUpOverdue");
  const statFollowUpScheduled = byId("statFollowUpScheduled");
  const statNoFollowUp = byId("statNoFollowUp");
  const statFollowUpOnTrack = byId("statFollowUpOnTrack");
  const statNeedsAttention = byId("statNeedsAttention");
  const statTriageEmergency = byId("statTriageEmergency");
  const statPriorityMismatch = byId("statPriorityMismatch");
  const statPriorityAligned = byId("statPriorityAligned");
  const statAdmittedCases = byId("statAdmittedCases");
  const statIcuCases = byId("statIcuCases");
  const statComorbidityCases = byId("statComorbidityCases");
  const statHighPainCases = byId("statHighPainCases");
  const statTeleConsultCases = byId("statTeleConsultCases");
  const statIcuTransferCases = byId("statIcuTransferCases");
  const statAveragePain = byId("statAveragePain");
  const statLastVisit = byId("statLastVisit");

  if (statTotal) {
    statTotal.innerText = String(total);
  }

  if (statHighRisk) {
    statHighRisk.innerText = String(highRisk);
  }

  if (statCritical) {
    statCritical.innerText = String(critical);
  }

  if (statModerate) {
    statModerate.innerText = String(moderate);
  }

  if (statLow) {
    statLow.innerText = String(low);
  }

  if (statAverage) {
    statAverage.innerText = `${average}%`;
  }

  if (statRoutine) {
    statRoutine.innerText = String(routineCount);
  }

  if (statUrgent) {
    statUrgent.innerText = String(urgentCount);
  }

  if (statEmergency) {
    statEmergency.innerText = String(emergencyCount);
  }

  if (statToday) {
    statToday.innerText = String(reportsToday);
  }

  if (statFollowUpDue) {
    statFollowUpDue.innerText = String(followUpDue);
  }

  if (statFollowUpToday) {
    statFollowUpToday.innerText = String(followUpToday);
  }

  if (statFollowUpOverdue) {
    statFollowUpOverdue.innerText = String(followUpOverdue);
  }

  if (statFollowUpScheduled) {
    statFollowUpScheduled.innerText = String(followUpScheduled);
  }

  if (statNoFollowUp) {
    statNoFollowUp.innerText = String(noFollowUp);
  }

  if (statFollowUpOnTrack) {
    statFollowUpOnTrack.innerText = String(followUpOnTrack);
  }

  if (statNeedsAttention) {
    statNeedsAttention.innerText = String(needsAttentionCount);
  }

  if (statTriageEmergency) {
    statTriageEmergency.innerText = String(triageEmergencyCount);
  }

  if (statPriorityMismatch) {
    statPriorityMismatch.innerText = String(priorityMismatchCount);
  }

  if (statPriorityAligned) {
    statPriorityAligned.innerText = String(priorityAlignedCount);
  }

  if (statAdmittedCases) {
    statAdmittedCases.innerText = String(admittedCases);
  }

  if (statIcuCases) {
    statIcuCases.innerText = String(icuCases);
  }

  if (statComorbidityCases) {
    statComorbidityCases.innerText = String(comorbidityCases);
  }

  if (statHighPainCases) {
    statHighPainCases.innerText = String(highPainCases);
  }

  if (statTeleConsultCases) {
    statTeleConsultCases.innerText = String(teleConsultCases);
  }

  if (statIcuTransferCases) {
    statIcuTransferCases.innerText = String(icuTransferCases);
  }

  if (statAveragePain) {
    statAveragePain.innerText = String(averagePain);
  }

  if (statLastVisit) {
    statLastVisit.innerText = lastVisit;
  }

  const ratio = (value) => (total > 0 ? Math.round((value / total) * 100) : 0);

  const meterMap = [
    ["meterLow", "meterLowLabel", ratio(low)],
    ["meterModerate", "meterModerateLabel", ratio(moderate)],
    ["meterHigh", "meterHighLabel", ratio(high)],
    ["meterCritical", "meterCriticalLabel", ratio(critical)]
  ];

  meterMap.forEach(([meterId, labelId, percent]) => {
    const meter = byId(meterId);
    const label = byId(labelId);
    if (meter) {
      meter.style.width = `${percent}%`;
    }
    if (label) {
      label.textContent = `${percent}%`;
    }
  });
}
