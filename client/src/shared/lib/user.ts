// Единая точка, где решаем, как показать человека — отображаемое имя, если
// задано, иначе логин (для аккаунтов, заведённых до появления display_name).
export function nameFor(u: { username: string; display_name?: string | null }): string {
  return (u.display_name && u.display_name.trim()) || u.username;
}
