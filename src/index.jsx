import './bridge.js';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import App from './App.jsx';
import { boot } from './state/actions.js';
import { preloadSymbols, CHROME_SYMBOLS } from './components/icons.jsx';

Promise.all([boot(), preloadSymbols(CHROME_SYMBOLS)]).then(() => createRoot(document.getElementById('root')).render(<App />));
