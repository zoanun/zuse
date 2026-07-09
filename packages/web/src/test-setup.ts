import '@testing-library/jest-dom'

// jsdom does not implement scrollIntoView; components that auto-scroll (MessageList)
// call it inside effects. Stub it so rendering under jsdom doesn't throw.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

// jsdom does not implement the object-URL API; the Composer creates blob URLs for
// instant image previews and revokes them on removal/unmount. Stub both so tests don't throw.
if (!URL.createObjectURL) {
  URL.createObjectURL = () => 'blob:mock'
  URL.revokeObjectURL = () => {}
}
