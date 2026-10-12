import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import SignIn from './pages/SignIn.jsx';
import Classes from './pages/Classes.jsx';
import Assessments from './pages/Assessment.jsx';
import AssessmentForm from './pages/AssessmentForm.jsx';
import ScoreEntry from './pages/ScoreEntry.jsx';
import Results from './pages/Results.jsx';

function RequireAuth({ children }) {
  const { actor } = useAuth();
  const location = useLocation();
  if (!actor) return <Navigate to="/sign-in" state={{ from: location }} replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Navigate to="/classes" replace />} />
        <Route path="classes" element={<Classes />} />
        <Route path="assessments" element={<Assessments />} />
        <Route path="assessments/new" element={<AssessmentForm />} />
        <Route path="assessments/:assessmentId/edit" element={<AssessmentForm />} />
        <Route path="assessments/:assessmentId/scores" element={<ScoreEntry />} />
        <Route path="results" element={<Results />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}