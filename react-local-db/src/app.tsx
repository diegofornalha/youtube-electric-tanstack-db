import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { IssuesList } from './pages/IssuesList'
import { CreateIssue } from './pages/CreateIssue'
import { IssueDetail } from './pages/IssueDetail'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<IssuesList />} />
        <Route path="/issues/new" element={<CreateIssue />} />
        <Route path="/issues/:id" element={<IssueDetail />} />
      </Routes>
    </BrowserRouter>
  )
}
