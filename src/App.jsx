import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import SignIn from './pages/SignIn.jsx';
import Classes from './pages/Classes.jsx';
import Assessments from './pages/Assessment.jsx';
import AssessmentForm from './pages/AssessmentForm.jsx';
import ScoreEntry from './pages/ScoreEntry.jsx';
import Results from './pages/Results.jsx';
import Teachers from './pages/Teachers.jsx';
import Students from './pages/Students.jsx';
import ReportCards from './pages/ReportCards.jsx';
import Terms from './pages/Terms.jsx';
import Attendance from './pages/Attendance.jsx';
import RiskPrediction from './pages/RiskPrediction.jsx';
import Dashboard from './pages/Dashboard.jsx';
import StudentProfile from './pages/StudentProfile.jsx';
import InterventionForm from './pages/InterventionForm.jsx';
import SchoolRisk from './pages/SchoolRisk.jsx';

function RequireAuth({ children }) {
  const { actor } = useAuth();
  const location = useLocation();
  if (!actor) return <Navigate to="/sign-in" state={{ from: location }} replace />;
  return children;
}

function RequireAdmin({ children }) {
  const { isAdmin } = useAuth();
  return isAdmin ? children : <Navigate to="/dashboard" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="students/:studentId/risk" element={<StudentProfile />} />
        <Route path="students/:studentId/interventions" element={<InterventionForm />} />
        <Route path="school-risk" element={<RequireAdmin><SchoolRisk /></RequireAdmin>} />
        <Route path="classes" element={<Classes />} />
        <Route path="assessments" element={<Assessments />} />
        <Route path="assessments/new" element={<AssessmentForm />} />
        <Route path="assessments/:assessmentId/edit" element={<AssessmentForm />} />
        <Route path="assessments/:assessmentId/scores" element={<ScoreEntry />} />
        <Route path="results" element={<Results />} />
        <Route path="classes/:classId/students" element={<Students />} />
        <Route path="report-cards" element={<ReportCards />} />
        <Route path="teachers" element={<RequireAdmin><Teachers /></RequireAdmin>} />
        <Route path="terms" element={<RequireAdmin><Terms /></RequireAdmin>} />
        <Route path="attendance" element={<Attendance />} />
        <Route path="risk" element={<RiskPrediction />} />
        <Route path="model-inputs" element={<Navigate to="/risk" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}