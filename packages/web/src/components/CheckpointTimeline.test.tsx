import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { CheckpointLite } from '@zuse/protocol'
import { CheckpointTimeline } from './CheckpointTimeline.js'

const checkpoints: CheckpointLite[] = [
  { id: 'cp1', label: 'Before refactor' },
  { id: 'cp2', label: 'After tests added' },
]

describe('CheckpointTimeline', () => {
  it('renders checkpoint labels', () => {
    render(<CheckpointTimeline checkpoints={checkpoints} thinking={false} onRevert={() => {}} />)
    expect(screen.getByText('Before refactor')).toBeInTheDocument()
    expect(screen.getByText('After tests added')).toBeInTheDocument()
  })

  it('shows "No checkpoints yet" when list is empty', () => {
    render(<CheckpointTimeline checkpoints={[]} thinking={false} onRevert={() => {}} />)
    expect(screen.getByText('No checkpoints yet')).toBeInTheDocument()
  })

  it('clicking Revert shows inline confirm/cancel buttons', () => {
    render(<CheckpointTimeline checkpoints={checkpoints} thinking={false} onRevert={() => {}} />)
    const [first] = screen.getAllByText('Revert')
    fireEvent.click(first!)
    expect(screen.getByText('Confirm')).toBeInTheDocument()
    expect(screen.getByText('Cancel')).toBeInTheDocument()
  })

  it('calls onRevert with checkpointId after confirm', () => {
    const onRevert = vi.fn()
    render(<CheckpointTimeline checkpoints={checkpoints} thinking={false} onRevert={onRevert} />)
    const [first] = screen.getAllByText('Revert')
    fireEvent.click(first!)
    fireEvent.click(screen.getByText('Confirm'))
    expect(onRevert).toHaveBeenCalledWith('cp1')
  })

  it('cancel dismisses the confirm step without calling onRevert', () => {
    const onRevert = vi.fn()
    render(<CheckpointTimeline checkpoints={checkpoints} thinking={false} onRevert={onRevert} />)
    const [first] = screen.getAllByText('Revert')
    fireEvent.click(first!)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onRevert).not.toHaveBeenCalled()
    expect(screen.getAllByText('Revert')).toHaveLength(2)
  })

  it('disables Revert buttons while thinking', () => {
    render(<CheckpointTimeline checkpoints={checkpoints} thinking={true} onRevert={() => {}} />)
    const revertBtns = screen.getAllByText('Revert') as HTMLButtonElement[]
    revertBtns.forEach((btn) => expect(btn).toBeDisabled())
  })

  it('sends {type:revert, checkpointId} on confirm (second checkpoint)', () => {
    const onRevert = vi.fn()
    render(<CheckpointTimeline checkpoints={checkpoints} thinking={false} onRevert={onRevert} />)
    const [, second] = screen.getAllByText('Revert')
    fireEvent.click(second!)
    fireEvent.click(screen.getByText('Confirm'))
    expect(onRevert).toHaveBeenCalledWith('cp2')
  })
})
