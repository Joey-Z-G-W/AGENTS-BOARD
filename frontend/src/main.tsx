import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthGate } from './components/AuthGate';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode>{import.meta.env.VITE_SERVICE_MODE === 'http' ? <AuthGate><App /></AuthGate> : <App />}</StrictMode>);
