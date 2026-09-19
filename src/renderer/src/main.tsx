import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'

document.body.dataset.platform = window.devlog.platform

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
