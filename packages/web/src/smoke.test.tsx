import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App.js'

describe('App scaffold', () => {
  it('renders', () => {
    render(<App />)
    expect(screen.getByText(/zuse web/i)).toBeInTheDocument()
  })
})
