const EVENT = 'xdt:meka-projects-roles-changed';

export function emitMekaProjectsRolesChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function onMekaProjectsRolesChanged(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
