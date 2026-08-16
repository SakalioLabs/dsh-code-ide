import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { IdeI18nProvider } from './i18n.tsx'
import './ide.module.css'

const root = document.getElementById('root')
if (root === null) throw new Error('dsh-code-ide: #root mount is missing')
createRoot(root).render(<StrictMode><IdeI18nProvider><App /></IdeI18nProvider></StrictMode>)
