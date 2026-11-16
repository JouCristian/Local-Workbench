import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from './state';
import App from './App';
import './styles.css';
import './ui.css';
import './motion.css';
import './iteration3.css';
import './batch-direction.css';
import './calendar-refinement.css';
import './personalization.css';
import './assistant.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider>
      <App />
    </Provider>
  </StrictMode>,
);
