import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Header } from './Header.js'
import { initialState } from '../state/reducer.js'

describe('Header', () => {
  it('shows ctx used / window / percent', () => {
    render(<Header state={{ ...initialState, connection: 'live', model: 'claude', contextTokens: 4700, contextWindow: 200000 }} onMenu={() => {}} />)
    expect(screen.getByText(/ctx 4.7k \/ 200.0k · 2%/)).toBeInTheDocument()
    expect(screen.getByText('connected')).toBeInTheDocument()
  })
})
