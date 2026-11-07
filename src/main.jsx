import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext.jsx';
import App from './App.jsx';
import './styles/global.css';

/*
 * A data router (createBrowserRouter) rather than <BrowserRouter>: only a data
 * router can block navigation, which useUnsavedChanges needs to stop unsaved
 * marks and settings being lost when someone clicks a link inside the app.
 * App still declares its routes with <Routes>, under this one catch-all route.
 */
const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <AuthProvider>
        <App />
      </AuthProvider>
    ),
  },
]);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
