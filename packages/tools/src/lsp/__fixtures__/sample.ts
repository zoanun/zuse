export function greet(name: string): string {
  return `hello ${name}`
}

const who = 'world'
export const message = greet(who)
