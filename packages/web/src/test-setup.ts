import '@testing-library/jest-dom'

// jsdom does not implement scrollIntoView; components that auto-scroll (MessageList)
// call it inside effects. Stub it so rendering under jsdom doesn't throw.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
