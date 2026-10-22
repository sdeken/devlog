import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { installCodeCopy } from './markdown'
import './styles.css'

document.body.dataset.platform = window.devlog.platform
installCodeCopy()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
