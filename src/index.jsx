import { createRoot } from 'react-dom/client';
import './styles/app.css';
import App from './App.jsx';
import { boot } from './state/actions.js';

boot().then(() => createRoot(document.getElementById('root')).render(<App />));
