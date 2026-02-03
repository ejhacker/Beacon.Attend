import { useState, useEffect, useRef, useCallback } from "react";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MENTOR_WHITELIST = ["faculty1@mru.edu.in","faculty2@mru.edu.in","admin@mru.edu.in","mentor@mru.edu.in"];
const TEACHER_WHITELIST = ["ekakshjeena@mru.edu.in","teacher2@mru.edu.in","ds.teacher@mru.edu.in","ml.teacher@mru.edu.in","subject.teacher@mru.edu.in"];
const PROX_MIN = 10, PROX_MAX = 15;
const LOC_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// ─── UTILS ────────────────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function getPos() {
  return new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy:true, timeout:8000, maximumAge:0 }));
}
function uid() { return `${Date.now()}_${Math.random().toString(36).slice(2,8)}`; }
function fmtTime(t) { // "08:30" → "8:30 AM"
  if (!t) return "—";
  const [h,m] = t.split(":").map(Number);
  return `${h===0?12:h>12?h-12:h}:${String(m).padStart(2,"0")} ${h<12?"AM":"PM"}`;
}

// ─── GEMINI TIMETABLE PARSER ──────────────────────────────────────────────────
// Uses real Gemini API when VITE_GEMINI_API_KEY is set, otherwise falls back to mock.
import { parseTimetableImage as geminiParse } from './geminiService';
async function parseTimetableImage(base64Str, role) {
  return geminiParse(base64Str);
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED STATE (lifted into a single provider-like wrapper via props)
// We use a single App component with all state at the top.
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // ── Auth ──
  const [user, setUser] = useState(null); // { email, role, id, name, rollNo, section }
  const [screen, setScreen] = useState("ROLE_SELECT"); // ROLE_SELECT | LOGIN | DASHBOARD

  // ── Data (in-memory, persisted to window.__ba__ for cross-session in artifact)
  const [timetable, setTimetable] = useState([]); // class sessions (mentor-owned)
  const [teacherTimetables, setTeacherTimetables] = useState([]);
  const [enrollments, setEnrollments] = useState({}); // studentId → enrollment
  const [attendance, setAttendance] = useState({}); // classId → record

  // ── UI state ──
  const [selectedRole, setSelectedRole] = useState(null);
  const [emailInput, setEmailInput] = useState("");
  const [loginError, setLoginError] = useState("");
  const [toast, setToast] = useState(null); // { msg, type: success|error|info }
  const [processing, setProcessing] = useState(false);
  const [processingMsg, setProcessingMsg] = useState("");
  const [cameraState, setCameraState] = useState(null); // { classId, type: ENTRY|COMPLETION|EVENT|CERT }
  const [eventInput, setEventInput] = useState("");
  const [eventModalClass, setEventModalClass] = useState(null);
  const [mentorTab, setMentorTab] = useState("classes");
  const [addStudentClass, setAddStudentClass] = useState(null);
  const [addStudentRoll, setAddStudentRoll] = useState("");
  const [enrollModal, setEnrollModal] = useState(false);
  const [enrollRoll, setEnrollRoll] = useState("");
  const [enrollSection, setEnrollSection] = useState("");

  // ── Restore persisted data on mount ──
  useEffect(() => {
    try {
      const d = window.__ba_data__;
      if (d) {
        if (d.timetable) setTimetable(d.timetable);
        if (d.teacherTimetables) setTeacherTimetables(d.teacherTimetables);
        if (d.enrollments) setEnrollments(d.enrollments);
        if (d.attendance) setAttendance(d.attendance);
      }
    } catch {}
  }, []);

  // ── Persist whenever data changes ──
  useEffect(() => {
    window.__ba_data__ = { timetable, teacherTimetables, enrollments, attendance };
  }, [timetable, teacherTimetables, enrollments, attendance]);

  // ── Toast auto-dismiss ──
  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }
  }, [toast]);

  // ── Teacher location auto-update every 30s ──
  useEffect(() => {
    if (user?.role !== "SUBJECT_TEACHER") return;
    let alive = true;
    async function tick() {
      if (!alive) return;
      const active = teacherTimetables.find(tt => tt.teacherId === user.id && tt.isActive);
      if (active) {
        try {
          const pos = await getPos();
          setTeacherTimetables(prev => prev.map(tt =>
            tt.id === active.id ? { ...tt, currentLocation: { lat: pos.coords.latitude, lng: pos.coords.longitude, timestamp: Date.now() } } : tt
          ));
        } catch {}
      }
    }
    tick();
    const iv = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(iv); };
  }, [user, teacherTimetables]);

  // ── Auto-activate attendance when class time matches ──
  useEffect(() => {
    function check() {
      const now = new Date();
      const cur = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
      timetable.forEach(s => {
        if (cur >= s.timeStart && cur <= s.timeEnd && !s.isLive) {
          const mt = teacherTimetables.find(tt =>
            tt.subject.toLowerCase() === s.subject.toLowerCase() &&
            tt.room === s.room && tt.timeStart === s.timeStart && tt.isActive && tt.currentLocation
          );
          if (mt) {
            setTimetable(prev => prev.map(c =>
              c.id === s.id ? { ...c, isLive: true, liveType: "ENTRY", facultyLocation: { ...mt.currentLocation }, autoActivated: true } : c
            ));
          }
        }
      });
    }
    check();
    const iv = setInterval(check, 60000);
    return () => clearInterval(iv);
  }, [timetable, teacherTimetables]);

  // ─── HANDLERS ─────────────────────────────────────────────────────────────
  const showToast = (msg, type = "info") => setToast({ msg, type });

  const handleLogin = () => {
    const email = emailInput.toLowerCase().trim();
    setLoginError("");
    if (selectedRole === "MENTOR") {
      if (!email.endsWith("@mru.edu.in")) return setLoginError("Must use @mru.edu.in email");
      if (!MENTOR_WHITELIST.includes(email)) return setLoginError("Email not in Mentor whitelist");
      setUser({ email, role:"MENTOR", id:`M_${email.split("@")[0]}`, name:"Mentor" });
      setScreen("DASHBOARD");
    } else if (selectedRole === "SUBJECT_TEACHER") {
      if (!email.endsWith("@mru.edu.in")) return setLoginError("Must use @mru.edu.in email");
      if (!TEACHER_WHITELIST.includes(email)) return setLoginError("Email not in Teacher whitelist");
      setUser({ email, role:"SUBJECT_TEACHER", id:`T_${email.split("@")[0]}`, name:"Teacher" });
      setScreen("DASHBOARD");
    } else {
      if (!email.endsWith("@mru.ac.in")) return setLoginError("Students must use @mru.ac.in email");
      const sid = `S_${email.split("@")[0]}`;
      if (enrollments[sid]) {
        const e = enrollments[sid];
        setUser({ email, role:"STUDENT", id:sid, name:e.studentRollNo, rollNo:e.studentRollNo, section:e.section });
        setScreen("DASHBOARD");
      } else {
        // Need enrollment
        setEnrollModal(true);
      }
    }
  };

  const completeEnrollment = () => {
    if (!enrollRoll || !enrollSection) return;
    const email = emailInput.toLowerCase().trim();
    const sid = `S_${email.split("@")[0]}`;
    const section = enrollSection.toUpperCase();
    const roll = enrollRoll.toUpperCase();
    const mc = timetable.find(c => c.section?.toUpperCase() === section);
    const mentorId = mc?.mentorId || "M_DEFAULT";
    setEnrollments(prev => ({
      ...prev,
      [sid]: { studentId:sid, studentEmail:email, studentRollNo:roll, mentorId, section, enrolledClasses:[] }
    }));
    setUser({ email, role:"STUDENT", id:sid, name:roll, rollNo:roll, section, mentorId });
    setEnrollModal(false);
    setScreen("DASHBOARD");
  };

  const handleTimetableUpload = async (file, role) => {
    if (!file) return;
    setProcessing(true);
    setProcessingMsg("Gemini AI is scanning your timetable…");
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = await parseTimetableImage(reader.result, role);
        if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
          throw new Error("No timetable data found in image");
        }
        if (role === "MENTOR") {
          const section = prompt("Enter section (e.g. AIML-1A, CSE-2B):") || "AIML-1A";
          const sessions = parsed.map(p => ({
            id: uid(), subject:p.subject, timeStart:p.timeStart, timeEnd:p.timeEnd,
            room:p.room, mentorId:user.id, section:section.toUpperCase(), students:[], isLive:false
          }));
          setTimetable(sessions);
          showToast(`Timetable synced for ${section.toUpperCase()}! ${sessions.length} classes loaded.`, "success");
        } else {
          const sessions = parsed.map(p => ({
            id: uid(), teacherId:user.id, teacherEmail:user.email,
            subject:p.subject, timeStart:p.timeStart, timeEnd:p.timeEnd, room:p.room, isActive:false
          }));
          setTeacherTimetables(prev => [...prev, ...sessions]);
          // count matches
          let matched = 0;
          sessions.forEach(ts => {
            if (timetable.find(c => c.subject.toLowerCase()===ts.subject.toLowerCase() && c.room===ts.room && c.timeStart===ts.timeStart)) matched++;
          });
          showToast(`Uploaded ${sessions.length} class(es). ${matched} matched with class timetable.`, "success");
        }
      } catch (e) {
        console.error("Timetable parsing error:", e);
        let errorMsg = "Failed to parse timetable. Try a clearer image.";
        if (e.message) {
          if (e.message.includes("API key") || e.message.includes("401") || e.message.includes("403")) {
            errorMsg = "API key missing or invalid. Check environment variables.";
          } else if (e.message.includes("Network") || e.message.includes("fetch")) {
            errorMsg = "Network error. Check your connection and try again.";
          } else if (e.message.includes("parse") || e.message.includes("JSON")) {
            errorMsg = "Could not extract timetable data. Try a clearer, well-lit image.";
          } else {
            errorMsg = e.message.length > 60 ? e.message.substring(0, 60) + "..." : e.message;
          }
        }
        showToast(errorMsg, "error");
      }
      setProcessing(false);
    };
    reader.readAsDataURL(file);
  };

  const toggleBeacon = async (classId, type) => {
    try {
      const pos = await getPos();
      setTimetable(prev => prev.map(c =>
        c.id === classId ? {
          ...c, isLive: !c.isLive, liveType: type,
          facultyLocation: { lat:pos.coords.latitude, lng:pos.coords.longitude, timestamp:Date.now() }
        } : c
      ));
      showToast(`${type} beacon activated • ${PROX_MIN}-${PROX_MAX}m range`, "success");
    } catch { showToast("Location access required.", "error"); }
  };

  const toggleTeacherTracking = async (ttId) => {
    const tt = teacherTimetables.find(t => t.id === ttId);
    if (!tt) return;
    try {
      const pos = await getPos();
      setTeacherTimetables(prev => prev.map(t =>
        t.id === ttId ? {
          ...t, isActive: !t.isActive,
          currentLocation: !t.isActive ? { lat:pos.coords.latitude, lng:pos.coords.longitude, timestamp:Date.now() } : undefined
        } : t
      ));
      showToast(!tt.isActive ? "Location tracking ON" : "Location tracking OFF", !tt.isActive?"success":"info");
    } catch { showToast("Location access required.", "error"); }
  };

  const handleProximityVerify = async (classId) => {
    const session = timetable.find(t => t.id === classId);
    if (!session?.isLive || !session.facultyLocation) return showToast("Beacon not active.", "error");
    if (Date.now() - session.facultyLocation.timestamp > LOC_MAX_AGE_MS) return showToast("Faculty location expired. Ask teacher to refresh.", "error");
    setProcessing(true); setProcessingMsg("Verifying your proximity…");
    try {
      const pos = await getPos();
      const dist = haversine(pos.coords.latitude, pos.coords.longitude, session.facultyLocation.lat, session.facultyLocation.lng);
      setProcessing(false);
      if (dist < PROX_MIN) return showToast(`Too close (${Math.round(dist)}m). Must be ${PROX_MIN}-${PROX_MAX}m away.`, "error");
      if (dist > PROX_MAX) return showToast(`Too far (${Math.round(dist)}m). Must be within ${PROX_MAX}m.`, "error");
      showToast(`Proximity OK (${Math.round(dist)}m). Capture your photo now.`, "success");
      setCameraState({ classId, type: session.liveType });
    } catch { setProcessing(false); showToast("Location access failed.", "error"); }
  };

  const onCameraCapture = async (imgData) => {
    const { classId, type } = cameraState;
    setCameraState(null);
    setProcessing(true); setProcessingMsg("Recording attendance…");
    // Second proximity check (anti-proxy)
    const session = timetable.find(t => t.id === classId);
    if (session?.facultyLocation && (type === "ENTRY" || type === "COMPLETION")) {
      if (Date.now() - session.facultyLocation.timestamp > LOC_MAX_AGE_MS) {
        setProcessing(false); return showToast("Denied: faculty location expired.", "error");
      }
      try {
        const pos = await getPos();
        const dist = haversine(pos.coords.latitude, pos.coords.longitude, session.facultyLocation.lat, session.facultyLocation.lng);
        if (dist < PROX_MIN || dist > PROX_MAX) {
          setProcessing(false); return showToast(`Denied: ${Math.round(dist)}m — outside allowed range.`, "error");
        }
      } catch { setProcessing(false); return showToast("Proximity re-check failed.", "error"); }
    }
    // Record
    setAttendance(prev => {
      const prev_rec = prev[classId] || { studentRollNo:user?.rollNo, studentName:user?.name };
      if (type === "ENTRY") return { ...prev, [classId]: { ...prev_rec, status:"PARTIAL", entryPhoto:imgData, entryTime:new Date().toLocaleTimeString() } };
      if (type === "COMPLETION") return { ...prev, [classId]: { ...prev_rec, status:"PRESENT", completionPhoto:imgData, completionTime:new Date().toLocaleTimeString() } };
      if (type === "EVENT") return { ...prev, [classId]: { ...prev_rec, status:"EVENT_PENDING_CERT", eventPhoto:imgData, eventComment:eventInput } };
      if (type === "CERT") return { ...prev, [classId]: { ...prev_rec, status:"EVENT_VERIFIED", certificatePhoto:imgData } };
      return prev;
    });
    setProcessing(false);
    showToast("Attendance recorded successfully.", "success");
  };

  const addStudent = () => {
    if (!addStudentRoll || !addStudentClass) return;
    const roll = addStudentRoll.toUpperCase();
    setTimetable(prev => prev.map(c =>
      c.id === addStudentClass ? { ...c, students:[...new Set([...(c.students||[]), roll])] } : c
    ));
    setAddStudentRoll("");
    setAddStudentClass(null);
    showToast(`${roll} added.`, "success");
  };

  // ─── RENDER ──────────────────────────────────────────────────────────────
  // We'll define sub-renders for clarity

  if (screen === "ROLE_SELECT") return <RoleSelect onSelect={r => { setSelectedRole(r); setScreen("LOGIN"); }} />;
  if (screen === "LOGIN") return (
    <LoginScreen
      role={selectedRole}
      email={emailInput}
      setEmail={setEmailInput}
      error={loginError}
      onSubmit={handleLogin}
      onBack={() => { setScreen("ROLE_SELECT"); setLoginError(""); }}
      enrollModal={enrollModal}
      enrollRoll={enrollRoll} setEnrollRoll={setEnrollRoll}
      enrollSection={enrollSection} setEnrollSection={setEnrollSection}
      onEnroll={completeEnrollment}
      onEnrollCancel={() => setEnrollModal(false)}
    />
  );

  // DASHBOARD
  return (
    <Layout user={user} onLogout={() => { setUser(null); setScreen("ROLE_SELECT"); setSelectedRole(null); setEmailInput(""); }}>
      {/* Toast */}
      {toast && <Toast msg={toast.msg} type={toast.type} />}
      {/* Processing overlay */}
      {processing && <ProcessingOverlay msg={processingMsg} />}
      {/* Camera */}
      {cameraState && <Camera onCapture={onCameraCapture} onCancel={() => setCameraState(null)} label={cameraState.type} />}
      {/* Event modal */}
      {eventModalClass && (
        <EventModal
          onClose={() => setEventModalClass(null)}
          value={eventInput} onChange={setEventInput}
          onSubmit={() => { setEventModalClass(null); setCameraState({ classId:eventModalClass, type:"EVENT" }); }}
        />
      )}
      {/* Add student modal */}
      {addStudentClass && (
        <AddStudentModal
          value={addStudentRoll} onChange={setAddStudentRoll}
          onAdd={addStudent} onCancel={() => setAddStudentClass(null)}
        />
      )}

      {/* ── MENTOR DASHBOARD ── */}
      {user.role === "MENTOR" && (
        <MentorDashboard
          timetable={timetable} user={user} enrollments={enrollments}
          mentorTab={mentorTab} setMentorTab={setMentorTab}
          onUpload={f => handleTimetableUpload(f, "MENTOR")}
          onToggleBeacon={toggleBeacon}
          onAddStudent={cid => setAddStudentClass(cid)}
          onRemoveStudent={(cid, roll) => setTimetable(prev => prev.map(c => c.id===cid ? { ...c, students:(c.students||[]).filter(s=>s!==roll) } : c))}
          onResetSemester={() => { if (confirm("Reset semester timetable?")) setTimetable([]); }}
        />
      )}

      {/* ── TEACHER DASHBOARD ── */}
      {user.role === "SUBJECT_TEACHER" && (
        <TeacherDashboard
          teacherTimetables={teacherTimetables} timetable={timetable} user={user}
          onUpload={f => handleTimetableUpload(f, "SUBJECT_TEACHER")}
          onToggleTracking={toggleTeacherTracking}
        />
      )}

      {/* ── STUDENT DASHBOARD ── */}
      {user.role === "STUDENT" && (
        <StudentDashboard
          timetable={timetable} enrollments={enrollments} user={user} attendance={attendance}
          onVerify={handleProximityVerify}
          onEvent={cid => { setEventInput(""); setEventModalClass(cid); }}
          onCert={cid => setCameraState({ classId:cid, type:"CERT" })}
        />
      )}
    </Layout>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// UI COMPONENTS
// ════════════════════════════════════════════════════════════════════════════════

// ─── TOAST ────────────────────────────────────────────────────────────────────
function Toast({ msg, type }) {
  const bg = type==="success" ? "#d1fae5" : type==="error" ? "#fee2e2" : "#dbeafe";
  const col = type==="success" ? "#065f46" : type==="error" ? "#991b1b" : "#1e40af";
  return (
    <div style={{ position:"fixed", top:20, left:"50%", transform:"translateX(-50%)", zIndex:9999, background:bg, color:col, borderRadius:14, padding:"12px 24px", fontWeight:700, fontSize:13, boxShadow:"0 4px 24px rgba(0,0,0,.15)", maxWidth:"90vw", textAlign:"center", animation:"slideDown .3s ease" }}>
      {msg}
      <style>{`@keyframes slideDown { from { opacity:0; transform:translateX(-50%) translateY(-20px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }`}</style>
    </div>
  );
}

// ─── PROCESSING OVERLAY ──────────────────────────────────────────────────────
function ProcessingOverlay({ msg }) {
  return (
    <div style={{ position:"fixed", inset:0, zIndex:9998, background:"rgba(15,23,42,.92)", backdropFilter:"blur(8px)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:24 }}>
      <div style={{ width:56, height:56, border:"4px solid rgba(34,197,94,.25)", borderTop:"4px solid #22c55e", borderRadius:"50%", animation:"spin .7s linear infinite" }} />
      <p style={{ color:"#fff", fontWeight:700, fontSize:16, letterSpacing:0.5 }}>{msg || "Processing…"}</p>
      <style>{`@keyframes spin { to { transform:rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── CAMERA ───────────────────────────────────────────────────────────────────
function Camera({ onCapture, onCancel, label }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [captured, setCaptured] = useState(null);

  useEffect(() => {
    let s;
    (async () => {
      try {
        s = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:"user" }, audio:false });
        setStream(s);
        if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play(); }
      } catch { /* fallback: show upload */ }
    })();
    return () => { if (s) s.getTracks().forEach(t => t.stop()); };
  }, []);

  const snap = () => {
    const v = videoRef.current, c = canvasRef.current;
    if (!v || !c) return;
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    setCaptured(c.toDataURL());
  };

  const confirm_ = () => { if (captured) onCapture(captured); };

  return (
    <div style={{ position:"fixed", inset:0, zIndex:9990, background:"#0f172a", display:"flex", flexDirection:"column", alignItems:"center" }}>
      <div style={{ position:"absolute", top:16, left:16, right:16, display:"flex", justifyContent:"space-between", zIndex:2 }}>
        <span style={{ color:"#94a3b8", fontWeight:700, fontSize:13 }}>{label} PHOTO</span>
        <button onClick={onCancel} style={{ background:"rgba(255,255,255,.12)", border:"none", color:"#fff", borderRadius:20, padding:"6px 16px", fontWeight:700, fontSize:13, cursor:"pointer" }}>Cancel</button>
      </div>
      <div style={{ flex:1, width:"100%", display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
        {!captured ? (
          <>
            <video ref={videoRef} autoPlay playsInline style={{ maxWidth:"100%", maxHeight:"70vh", borderRadius:16, objectFit:"cover" }} />
            <canvas ref={canvasRef} style={{ display:"none" }} />
          </>
        ) : <img src={captured} alt="snap" style={{ maxWidth:"100%", maxHeight:"70vh", borderRadius:16 }} />}
      </div>
      <div style={{ width:"100%", padding:"0 24px 32px", display:"flex", gap:12 }}>
        {!captured ? (
          <button onClick={snap} style={{ flex:1, background:"#22c55e", color:"#fff", border:"none", borderRadius:16, padding:"16px 0", fontWeight:800, fontSize:15, cursor:"pointer" }}>Capture</button>
        ) : (
          <>
            <button onClick={() => setCaptured(null)} style={{ flex:1, background:"rgba(255,255,255,.1)", color:"#fff", border:"none", borderRadius:16, padding:"16px 0", fontWeight:700, fontSize:14, cursor:"pointer" }}>Retake</button>
            <button onClick={confirm_} style={{ flex:1, background:"#3b82f6", color:"#fff", border:"none", borderRadius:16, padding:"16px 0", fontWeight:800, fontSize:15, cursor:"pointer" }}>Confirm</button>
          </>
        )}
      </div>
      {/* Fallback file upload if camera unavailable */}
      {!stream && !captured && (
        <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:12, background:"#0f172a" }}>
          <p style={{ color:"#94a3b8", fontWeight:600, fontSize:14 }}>Camera not available. Upload a photo instead.</p>
          <label style={{ background:"#3b82f6", color:"#fff", padding:"12px 28px", borderRadius:14, fontWeight:700, fontSize:14, cursor:"pointer" }}>
            Choose Photo
            <input type="file" accept="image/*" style={{ display:"none" }} onChange={e => {
              const f = e.target.files?.[0]; if (!f) return;
              const r = new FileReader(); r.onload = () => setCaptured(r.result); r.readAsDataURL(f);
            }} />
          </label>
        </div>
      )}
    </div>
  );
}

// ─── EVENT MODAL ──────────────────────────────────────────────────────────────
function EventModal({ onClose, value, onChange, onSubmit }) {
  return (
    <div style={{ position:"fixed", inset:0, zIndex:9980, background:"rgba(0,0,0,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ background:"#fff", borderRadius:24, padding:32, width:"100%", maxWidth:400, boxShadow:"0 20px 60px rgba(0,0,0,.3)" }}>
        <h3 style={{ margin:0, fontSize:20, fontWeight:800, color:"#0f172a" }}>Event Check-In</h3>
        <p style={{ color:"#64748b", fontSize:13, margin:"6px 0 20px" }}>Describe the event & location. You'll upload a certificate later.</p>
        <textarea value={value} onChange={e => onChange(e.target.value)} placeholder="Event name & location…" style={{ width:"100%", height:100, border:"2px solid #e2e8f0", borderRadius:14, padding:14, fontFamily:"inherit", fontSize:14, fontWeight:600, resize:"none", outline:"none", boxSizing:"border-box" }} onFocus={e => e.target.style.borderColor="#3b82f6"} onBlur={e => e.target.style.borderColor="#e2e8f0"} />
        <div style={{ display:"flex", gap:12, marginTop:20 }}>
          <button onClick={onClose} style={{ flex:1, background:"#f1f5f9", border:"none", borderRadius:14, padding:"12px 0", fontWeight:700, fontSize:14, cursor:"pointer", color:"#64748b" }}>Cancel</button>
          <button onClick={onSubmit} disabled={!value} style={{ flex:1, background: value?"#3b82f6":"#cbd5e1", color:"#fff", border:"none", borderRadius:14, padding:"12px 0", fontWeight:800, fontSize:14, cursor:value?"pointer":"default" }}>Take Photo</button>
        </div>
      </div>
    </div>
  );
}

// ─── ADD STUDENT MODAL ────────────────────────────────────────────────────────
function AddStudentModal({ value, onChange, onAdd, onCancel }) {
  return (
    <div style={{ position:"fixed", inset:0, zIndex:9980, background:"rgba(0,0,0,.6)", backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ background:"#fff", borderRadius:24, padding:32, width:"100%", maxWidth:360, boxShadow:"0 20px 60px rgba(0,0,0,.3)" }}>
        <h3 style={{ margin:0, fontSize:18, fontWeight:800, color:"#0f172a" }}>Add Student</h3>
        <p style={{ color:"#64748b", fontSize:13, margin:"4px 0 16px" }}>Enter roll number to enroll.</p>
        <input value={value} onChange={e => onChange(e.target.value)} placeholder="e.g. AIML2024001" style={{ width:"100%", border:"2px solid #e2e8f0", borderRadius:14, padding:"12px 16px", fontSize:15, fontWeight:600, outline:"none", boxSizing:"border-box" }} onFocus={e => e.target.style.borderColor="#3b82f6"} onBlur={e => e.target.style.borderColor="#e2e8f0"} />
        <div style={{ display:"flex", gap:12, marginTop:18 }}>
          <button onClick={onCancel} style={{ flex:1, background:"#f1f5f9", border:"none", borderRadius:14, padding:"11px 0", fontWeight:700, fontSize:14, cursor:"pointer", color:"#64748b" }}>Cancel</button>
          <button onClick={onAdd} disabled={!value} style={{ flex:1, background:value?"#3b82f6":"#cbd5e1", color:"#fff", border:"none", borderRadius:14, padding:"11px 0", fontWeight:800, fontSize:14, cursor:value?"pointer":"default" }}>Add</button>
        </div>
      </div>
    </div>
  );
}

// ─── ROLE SELECT SCREEN ───────────────────────────────────────────────────────
function RoleSelect({ onSelect }) {
  const roles = [
    { id:"STUDENT", label:"Student", sub:"Mark your attendance", icon:"🎓", grad:"from-indigo-500 to-blue-600" },
    { id:"MENTOR", label:"Mentor", sub:"Manage class timetable", icon:"👥", grad:"from-violet-500 to-purple-600" },
    { id:"SUBJECT_TEACHER", label:"Subject Teacher", sub:"Upload & track classes", icon:"📖", grad:"from-emerald-500 to-teal-600" },
  ];
  return (
    <div style={{ minHeight:"100vh", background:"linear-gradient(135deg,#0f172a 0%,#1e293b 50%,#0f172a 100%)", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
      <div style={{ width:"100%", maxWidth:400 }}>
        {/* Logo area */}
        <div style={{ textAlign:"center", marginBottom:48 }}>
          <div style={{ display:"inline-flex", alignItems:"center", gap:12, background:"rgba(255,255,255,.06)", borderRadius:16, padding:"10px 20px", border:"1px solid rgba(255,255,255,.1)" }}>
            <span style={{ fontSize:22 }}>📍</span>
            <span style={{ color:"#fff", fontWeight:900, fontSize:20, letterSpacing:-0.5 }}>BeaconAttend</span>
          </div>
          <p style={{ color:"#64748b", fontSize:13, fontWeight:600, marginTop:12, letterSpacing:1.5, textTransform:"uppercase" }}>MRU Attendance System</p>
        </div>
        {/* Role cards */}
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {roles.map(r => (
            <button key={r.id} onClick={() => onSelect(r.id)} style={{ background:"rgba(255,255,255,.05)", border:"1px solid rgba(255,255,255,.1)", borderRadius:20, padding:"20px 24px", display:"flex", alignItems:"center", gap:18, cursor:"pointer", transition:"all .2s", textAlign:"left" }}
              onMouseEnter={e => { e.currentTarget.style.background="rgba(255,255,255,.1)"; e.currentTarget.style.borderColor="rgba(255,255,255,.25)"; e.currentTarget.style.transform="translateY(-2px)"; }}
              onMouseLeave={e => { e.currentTarget.style.background="rgba(255,255,255,.05)"; e.currentTarget.style.borderColor="rgba(255,255,255,.1)"; e.currentTarget.style.transform="translateY(0)"; }}
            >
              <div style={{ width:52, height:52, borderRadius:16, background:"linear-gradient(135deg,rgba(59,130,246,.3),rgba(139,92,246,.3))", display:"flex", alignItems:"center", justifyContent:"center", fontSize:24 }}>{r.icon}</div>
              <div>
                <div style={{ color:"#fff", fontWeight:800, fontSize:16 }}>{r.label}</div>
                <div style={{ color:"#64748b", fontWeight:600, fontSize:13 }}>{r.sub}</div>
              </div>
              <div style={{ marginLeft:"auto", color:"#475569", fontSize:20 }}>›</div>
            </button>
          ))}
        </div>
        <p style={{ textAlign:"center", color:"#475569", fontSize:11, marginTop:40, fontWeight:600 }}>Proxy-proof • GPS verified • AI powered</p>
      </div>
    </div>
  );
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({ role, email, setEmail, error, onSubmit, onBack, enrollModal, enrollRoll, setEnrollRoll, enrollSection, setEnrollSection, onEnroll, onEnrollCancel }) {
  const domainHint = role === "STUDENT" ? "@mru.ac.in" : "@mru.edu.in";
  const roleLabel = role === "STUDENT" ? "Student" : role === "MENTOR" ? "Mentor" : "Subject Teacher";
  return (
    <div style={{ minHeight:"100vh", background:"linear-gradient(135deg,#0f172a 0%,#1e293b 50%,#0f172a 100%)", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
      <div style={{ width:"100%", maxWidth:400, background:"rgba(255,255,255,.06)", border:"1px solid rgba(255,255,255,.1)", borderRadius:28, padding:36 }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:"#64748b", fontWeight:700, fontSize:13, cursor:"pointer", padding:0, display:"flex", alignItems:"center", gap:6 }}>← Back</button>
        <h2 style={{ color:"#fff", fontWeight:900, fontSize:24, margin:"24px 0 4px" }}>{roleLabel} Login</h2>
        <p style={{ color:"#64748b", fontSize:13, fontWeight:600, margin:"0 0 28px" }}>Use your {domainHint} email</p>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={`you${domainHint}`} onKeyDown={e => e.key==="Enter" && onSubmit()}
          style={{ width:"100%", background:"rgba(255,255,255,.08)", border:"1px solid rgba(255,255,255,.15)", borderRadius:16, padding:"14px 18px", color:"#fff", fontSize:15, fontWeight:600, outline:"none", boxSizing:"border-box" }}
          onFocus={e => e.target.style.borderColor="#3b82f6"} onBlur={e => e.target.style.borderColor="rgba(255,255,255,.15)"} autoFocus
        />
        {error && <p style={{ color:"#f87171", fontWeight:700, fontSize:12, margin:"8px 0 0" }}>{error}</p>}
        <button onClick={onSubmit} style={{ width:"100%", marginTop:20, background:"linear-gradient(135deg,#3b82f6,#6366f1)", color:"#fff", border:"none", borderRadius:16, padding:"15px 0", fontWeight:800, fontSize:15, cursor:"pointer", boxShadow:"0 4px 20px rgba(99,102,241,.4)" }}>Access Portal</button>
        {(role === "MENTOR" || role === "SUBJECT_TEACHER") && <p style={{ textAlign:"center", color:"#475569", fontSize:11, marginTop:12, fontWeight:600 }}>Whitelist verification active</p>}
      </div>
      {/* Enrollment modal for new students */}
      {enrollModal && (
        <div style={{ position:"fixed", inset:0, zIndex:9999, background:"rgba(0,0,0,.7)", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div style={{ background:"#fff", borderRadius:24, padding:32, width:"100%", maxWidth:380 }}>
            <h3 style={{ margin:0, fontWeight:800, fontSize:18, color:"#0f172a" }}>First Time? Enroll</h3>
            <p style={{ color:"#64748b", fontSize:13, margin:"4px 0 18px" }}>Enter your roll number & section to get started.</p>
            <input value={enrollRoll} onChange={e => setEnrollRoll(e.target.value)} placeholder="Roll No (e.g. AIML2024001)" style={{ width:"100%", border:"2px solid #e2e8f0", borderRadius:14, padding:"12px 16px", fontSize:14, fontWeight:600, outline:"none", boxSizing:"border-box", marginBottom:10 }} />
            <input value={enrollSection} onChange={e => setEnrollSection(e.target.value)} placeholder="Section (e.g. AIML-1A)" style={{ width:"100%", border:"2px solid #e2e8f0", borderRadius:14, padding:"12px 16px", fontSize:14, fontWeight:600, outline:"none", boxSizing:"border-box" }} />
            <div style={{ display:"flex", gap:12, marginTop:20 }}>
              <button onClick={onEnrollCancel} style={{ flex:1, background:"#f1f5f9", border:"none", borderRadius:14, padding:"11px 0", fontWeight:700, fontSize:14, cursor:"pointer", color:"#64748b" }}>Cancel</button>
              <button onClick={onEnroll} disabled={!enrollRoll||!enrollSection} style={{ flex:1, background:(enrollRoll&&enrollSection)?"#3b82f6":"#cbd5e1", color:"#fff", border:"none", borderRadius:14, padding:"11px 0", fontWeight:800, fontSize:14, cursor:(enrollRoll&&enrollSection)?"pointer":"default" }}>Enroll & Login</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── LAYOUT WRAPPER ───────────────────────────────────────────────────────────
function Layout({ user, onLogout, children }) {
  const roleColor = user.role==="MENTOR" ? "#8b5cf6" : user.role==="SUBJECT_TEACHER" ? "#10b981" : "#3b82f6";
  return (
    <div style={{ minHeight:"100vh", background:"#f0f4f8", paddingBottom:24 }}>
      {/* Header */}
      <div style={{ background:"#0f172a", padding:"16px 20px", display:"flex", alignItems:"center", justifyContent:"space-between", position:"sticky", top:0, zIndex:100, boxShadow:"0 2px 12px rgba(0,0,0,.2)" }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:16 }}>📍</span>
            <span style={{ color:"#fff", fontWeight:900, fontSize:17 }}>BeaconAttend</span>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:2 }}>
            <span style={{ background:roleColor, color:"#fff", fontSize:9, fontWeight:800, padding:"2px 8px", borderRadius:8, letterSpacing:0.8, textTransform:"uppercase" }}>{user.role.replace("_"," ")}</span>
            <span style={{ color:"#64748b", fontSize:11, fontWeight:600 }}>{user.rollNo || user.email.split("@")[0]}</span>
          </div>
        </div>
        <button onClick={onLogout} style={{ background:"rgba(255,255,255,.08)", border:"1px solid rgba(255,255,255,.12)", borderRadius:12, padding:"8px 14px", color:"#94a3b8", fontWeight:700, fontSize:12, cursor:"pointer" }}>Logout</button>
      </div>
      <div style={{ maxWidth:480, margin:"0 auto", padding:"20px 16px" }}>{children}</div>
    </div>
  );
}

// ─── FILE UPLOAD BUTTON ───────────────────────────────────────────────────────
function UploadArea({ onFile, label, sub }) {
  const ref = useRef(null);
  return (
    <div style={{ background:"#fff", borderRadius:22, border:"2px dashed #e2e8f0", padding:40, textAlign:"center" }}>
      <div style={{ width:64, height:64, background:"#eef2ff", borderRadius:18, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 16px", fontSize:28 }}>📷</div>
      <h4 style={{ margin:0, fontWeight:800, fontSize:17, color:"#0f172a" }}>{label}</h4>
      <p style={{ color:"#64748b", fontSize:13, fontWeight:500, margin:"6px 0 20px" }}>{sub}</p>
      <input ref={ref} type="file" accept="image/*" style={{ display:"none" }} onChange={e => { onFile(e.target.files?.[0]); e.target.value=""; }} />
      <button onClick={() => ref.current?.click()} style={{ background:"linear-gradient(135deg,#3b82f6,#6366f1)", color:"#fff", border:"none", borderRadius:14, padding:"12px 32px", fontWeight:800, fontSize:14, cursor:"pointer", boxShadow:"0 4px 16px rgba(99,102,241,.35)" }}>Select Image</button>
    </div>
  );
}

// ─── LIVE PULSE BADGE ─────────────────────────────────────────────────────────
function LiveBadge({ label, color = "#22c55e" }) {
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:5, background:color+"22", color, fontSize:10, fontWeight:800, padding:"3px 10px", borderRadius:20, letterSpacing:0.8, textTransform:"uppercase" }}>
      <span style={{ width:7, height:7, borderRadius:"50%", background:color, animation:"pulse 1.4s infinite" }} />
      {label}
      <style>{`@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.4; } }`}</style>
    </span>
  );
}

// status badge
function StatusBadge({ status }) {
  const map = { PARTIAL:["#f59e0b","Partial"], PRESENT:["#22c55e","Present"], EVENT_PENDING_CERT:["#f97316","Cert Pending"], EVENT_VERIFIED:["#3b82f6","Verified"], ABSENT:["#94a3b8","Absent"] };
  const [c, l] = map[status] || ["#94a3b8","—"];
  return <span style={{ background:c+"1a", color:c, fontSize:10, fontWeight:800, padding:"3px 10px", borderRadius:20, letterSpacing:0.6 }}>{l}</span>;
}

// ─── MENTOR DASHBOARD ─────────────────────────────────────────────────────────
function MentorDashboard({ timetable, user, enrollments, mentorTab, setMentorTab, onUpload, onToggleBeacon, onAddStudent, onRemoveStudent, onResetSemester }) {
  const myClasses = timetable.filter(c => c.mentorId === user.id);
  const myStudents = Object.values(enrollments).filter(e => e.mentorId === user.id);

  if (myClasses.length === 0) return <UploadArea onFile={onUpload} label="Upload Class Timetable" sub="Gemini AI will parse your semester schedule automatically." />;

  return (
    <div>
      {/* Tab switcher */}
      <div style={{ display:"flex", background:"#fff", borderRadius:16, border:"1px solid #e2e8f0", padding:4, marginBottom:20 }}>
        {["classes","students"].map(t => (
          <button key={t} onClick={() => setMentorTab(t)} style={{ flex:1, background:mentorTab===t?"#0f172a":"transparent", color:mentorTab===t?"#fff":"#64748b", border:"none", borderRadius:12, padding:"10px 0", fontWeight:700, fontSize:13, cursor:"pointer", transition:"all .2s", textTransform:"capitalize" }}>{t}</button>
        ))}
      </div>

      {mentorTab === "classes" ? (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          {myClasses.map(cls => (
            <div key={cls.id} style={{ background:"#fff", borderRadius:20, padding:20, border:"1px solid #e2e8f0", boxShadow:"0 2px 8px rgba(0,0,0,.04)" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14 }}>
                <div>
                  <h4 style={{ margin:0, fontWeight:800, fontSize:16, color:"#0f172a" }}>{cls.subject}</h4>
                  <p style={{ margin:"4px 0 0", color:"#64748b", fontSize:12, fontWeight:600 }}>{cls.room} • {fmtTime(cls.timeStart)} – {fmtTime(cls.timeEnd)}</p>
                  {cls.section && <span style={{ fontSize:11, color:"#6366f1", fontWeight:700 }}>Section: {cls.section}</span>}
                </div>
                <div style={{ textAlign:"right" }}>
                  <div style={{ fontWeight:900, fontSize:22, color:"#0f172a", lineHeight:1 }}>{cls.students?.length || 0}</div>
                  <div style={{ fontSize:10, color:"#94a3b8", fontWeight:700, textTransform:"uppercase" }}>enrolled</div>
                </div>
              </div>
              {cls.isLive && <div style={{ marginBottom:10 }}><LiveBadge label={`${cls.liveType} active`} /></div>}
              <div style={{ display:"flex", gap:10 }}>
                <button onClick={() => onToggleBeacon(cls.id, "ENTRY")} style={{ flex:1, background:cls.isLive&&cls.liveType==="ENTRY"?"#dcfce7":"#22c55e", color:cls.isLive&&cls.liveType==="ENTRY"?"#166534":"#fff", border:"none", borderRadius:12, padding:"11px 0", fontWeight:800, fontSize:12, cursor:"pointer" }}>
                  {cls.isLive&&cls.liveType==="ENTRY" ? "⏹ Stop Entry" : "▶ Entry"}
                </button>
                <button onClick={() => onToggleBeacon(cls.id, "COMPLETION")} style={{ flex:1, background:cls.isLive&&cls.liveType==="COMPLETION"?"#dbeafe":"#3b82f6", color:cls.isLive&&cls.liveType==="COMPLETION"?"#1e40af":"#fff", border:"none", borderRadius:12, padding:"11px 0", fontWeight:800, fontSize:12, cursor:"pointer" }}>
                  {cls.isLive&&cls.liveType==="COMPLETION" ? "⏹ Stop Comp." : "▶ Completion"}
                </button>
                <button onClick={() => onAddStudent(cls.id)} style={{ background:"#f1f5f9", border:"none", borderRadius:12, padding:"11px 14px", fontWeight:800, fontSize:16, cursor:"pointer", color:"#6366f1" }}>+</button>
              </div>
            </div>
          ))}
          <UploadArea onFile={onUpload} label="Re-upload Timetable" sub="Replace current semester schedule." />
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {myStudents.length === 0 && <div style={{ background:"#fff", borderRadius:18, padding:40, textAlign:"center", color:"#94a3b8", fontWeight:600, fontSize:14, border:"1px solid #e2e8f0" }}>No students enrolled yet. They'll appear when they log in.</div>}
          {myStudents.map(e => (
            <div key={e.studentId} style={{ background:"#fff", borderRadius:18, padding:16, border:"1px solid #e2e8f0", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <div>
                <div style={{ fontWeight:800, fontSize:14, color:"#0f172a" }}>{e.studentRollNo}</div>
                <div style={{ fontSize:12, color:"#64748b" }}>{e.section} • {e.studentEmail}</div>
              </div>
              <span style={{ fontSize:10, fontWeight:800, color:"#22c55e", background:"#dcfce7", padding:"3px 10px", borderRadius:12 }}>Enrolled</span>
            </div>
          ))}
          {/* Per-class roster */}
          <div style={{ borderTop:"1px solid #e2e8f0", paddingTop:16, marginTop:8 }}>
            <h5 style={{ margin:"0 0 12px", fontWeight:700, fontSize:13, color:"#475569" }}>Class Rosters</h5>
            {myClasses.map(cls => (
              <div key={cls.id} style={{ background:"#fff", borderRadius:16, padding:16, border:"1px solid #e2e8f0", marginBottom:10 }}>
                <div style={{ fontWeight:700, fontSize:14, color:"#0f172a", marginBottom:8 }}>{cls.subject}</div>
                {(cls.students||[]).map(s => (
                  <div key={s} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", background:"#f8fafc", borderRadius:10, padding:"6px 12px", marginBottom:4 }}>
                    <span style={{ fontSize:13, fontWeight:600, color:"#475569" }}>{s}</span>
                    <button onClick={() => onRemoveStudent(cls.id, s)} style={{ background:"none", border:"none", color:"#ef4444", fontWeight:700, fontSize:11, cursor:"pointer" }}>Remove</button>
                  </div>
                ))}
                {!(cls.students||[]).length && <p style={{ color:"#94a3b8", fontSize:12, margin:"4px 0 0" }}>No students yet</p>}
              </div>
            ))}
          </div>
          <button onClick={onResetSemester} style={{ background:"none", border:"1px solid #fca5a5", color:"#ef4444", borderRadius:14, padding:"10px 0", fontWeight:700, fontSize:13, cursor:"pointer", marginTop:8 }}>Reset Semester Timetable</button>
        </div>
      )}
    </div>
  );
}

// ─── TEACHER DASHBOARD ────────────────────────────────────────────────────────
function TeacherDashboard({ teacherTimetables, timetable, user, onUpload, onToggleTracking }) {
  const myTT = teacherTimetables.filter(t => t.teacherId === user.id);

  if (myTT.length === 0) return <UploadArea onFile={onUpload} label="Upload Your Teaching Timetable" sub="It'll auto-match with the class timetable. Enable tracking to activate attendance." />;

  return (
    <div>
      <div style={{ background:"#eef2ff", border:"1px solid #c7d2fe", borderRadius:16, padding:"12px 16px", marginBottom:18 }}>
        <p style={{ margin:0, color:"#4338ca", fontSize:13, fontWeight:700, textAlign:"center" }}>💡 Enable location tracking per class. Attendance auto-activates at class time.</p>
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
        {myTT.map(tt => {
          const matched = timetable.find(c => c.subject.toLowerCase()===tt.subject.toLowerCase() && c.room===tt.room && c.timeStart===tt.timeStart);
          const autoActive = matched?.autoActivated && matched?.isLive;
          return (
            <div key={tt.id} style={{ background:"#fff", borderRadius:20, padding:20, border:"1px solid #e2e8f0" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
                <div>
                  <h4 style={{ margin:0, fontWeight:800, fontSize:16, color:"#0f172a" }}>{tt.subject}</h4>
                  <p style={{ margin:"4px 0 0", color:"#64748b", fontSize:12, fontWeight:600 }}>{tt.room} • {fmtTime(tt.timeStart)} – {fmtTime(tt.timeEnd)}</p>
                </div>
                <div style={{ display:"flex", gap:6, flexDirection:"column", alignItems:"flex-end" }}>
                  {tt.isActive && <LiveBadge label="Tracking" />}
                  {matched && <span style={{ background:"#dbeafe", color:"#1e40af", fontSize:10, fontWeight:800, padding:"2px 8px", borderRadius:12 }}>Matched</span>}
                </div>
              </div>
              {autoActive && <div style={{ marginBottom:10 }}><LiveBadge label="Attendance Active" color="#22c55e" /></div>}
              <button onClick={() => onToggleTracking(tt.id)} style={{ width:"100%", background:tt.isActive ? "#fee2e2" : "linear-gradient(135deg,#22c55e,#16a34a)", color:tt.isActive?"#991b1b":"#fff", border:"none", borderRadius:12, padding:"11px 0", fontWeight:800, fontSize:13, cursor:"pointer" }}>
                {tt.isActive ? "⏹ Stop Tracking" : "▶ Start Location Tracking"}
              </button>
              {tt.isActive && tt.currentLocation && <p style={{ margin:"8px 0 0", textAlign:"center", color:"#64748b", fontSize:11, fontWeight:600 }}>📍 Location live • auto-activates at {fmtTime(tt.timeStart)}</p>}
            </div>
          );
        })}
        <UploadArea onFile={onUpload} label="Add More Classes" sub="Upload another timetable image." />
      </div>
    </div>
  );
}

// ─── STUDENT DASHBOARD ────────────────────────────────────────────────────────
function StudentDashboard({ timetable, enrollments, user, attendance, onVerify, onEvent, onCert }) {
  const enrollment = enrollments[user.id];
  const myClasses = enrollment
    ? timetable.filter(c => c.section?.toUpperCase() === enrollment.section && c.mentorId === enrollment.mentorId)
    : [];

  return (
    <div>
      {/* Info bar */}
      <div style={{ background:"#eef2ff", border:"1px solid #c7d2fe", borderRadius:16, padding:"10px 16px", marginBottom:18, display:"flex", alignItems:"center", gap:12 }}>
        <span style={{ fontSize:22 }}>🎓</span>
        <div>
          <span style={{ fontWeight:800, fontSize:13, color:"#312e81" }}>{user.rollNo || "—"}</span>
          <span style={{ color:"#6366f1", fontSize:12, fontWeight:600, marginLeft:10 }}>{user.section || "—"}</span>
        </div>
      </div>

      {myClasses.length === 0 && (
        <div style={{ background:"#fff", borderRadius:18, padding:48, textAlign:"center", color:"#94a3b8", fontWeight:600, fontSize:14, border:"1px solid #e2e8f0" }}>
          Waiting for your mentor to upload the schedule…
        </div>
      )}

      <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
        {myClasses.map(cls => {
          const rec = attendance[cls.id];
          return (
            <div key={cls.id} style={{ background:"#fff", borderRadius:20, padding:20, border:"1px solid #e2e8f0", boxShadow:"0 2px 8px rgba(0,0,0,.04)" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14 }}>
                <div>
                  <h4 style={{ margin:0, fontWeight:800, fontSize:16, color:"#0f172a" }}>{cls.subject}</h4>
                  <p style={{ margin:"4px 0 0", color:"#64748b", fontSize:12, fontWeight:600 }}>{cls.room} • {fmtTime(cls.timeStart)} – {fmtTime(cls.timeEnd)}</p>
                </div>
                {rec?.status ? <StatusBadge status={rec.status} /> : <StatusBadge status="ABSENT" />}
              </div>

              {/* Action buttons */}
              <div style={{ display:"flex", gap:10 }}>
                {cls.isLive && (
                  <button onClick={() => onVerify(cls.id)} style={{ flex:1, background:"linear-gradient(135deg,#3b82f6,#6366f1)", color:"#fff", border:"none", borderRadius:12, padding:"12px 0", fontWeight:800, fontSize:13, cursor:"pointer", boxShadow:"0 3px 14px rgba(99,102,241,.35)" }}>
                    ✓ Verify {cls.liveType}
                  </button>
                )}
                <button onClick={() => onEvent(cls.id)} style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", color:"#475569", borderRadius:12, padding:"12px 16px", fontWeight:700, fontSize:12, cursor:"pointer" }}>Event</button>
                {rec?.status === "EVENT_PENDING_CERT" && (
                  <button onClick={() => onCert(cls.id)} style={{ background:"#fff7ed", border:"1px solid #fdba74", color:"#c2410c", borderRadius:12, padding:"12px 14px", fontWeight:800, fontSize:11, cursor:"pointer" }}>Upload Cert</button>
                )}
              </div>

              {!cls.isLive && !rec && <p style={{ margin:"10px 0 0", color:"#94a3b8", fontSize:12, fontWeight:600, textAlign:"center" }}>Attendance not yet started by teacher</p>}
              {cls.autoActivated && cls.isLive && <p style={{ margin:"8px 0 0", color:"#22c55e", fontSize:11, fontWeight:700, textAlign:"center" }}>⚡ Auto-activated</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
