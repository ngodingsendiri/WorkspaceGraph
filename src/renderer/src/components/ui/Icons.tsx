/**
 * Google Material Symbols icons (fonts.google.com/icons)
 * Usage: <Icon name="search" size={16} />
 *
 * Ligature names map to Material Symbols Outlined.
 * See: https://fonts.google.com/icons
 */
import React from 'react'

export type IconName =
  | 'dashboard'
  | 'file'
  | 'folder'
  | 'folderOpen'
  | 'graph'
  | 'search'
  | 'settings'
  | 'plus'
  | 'close'
  | 'chevronRight'
  | 'sidebar'
  | 'panelRight'
  | 'trash'
  | 'save'
  | 'copy'
  | 'append'
  | 'chat'
  | 'bold'
  | 'italic'
  | 'heading'
  | 'link'
  | 'check'
  | 'code'
  | 'quote'
  | 'preview'
  | 'template'
  | 'daily'
  | 'openFolder'
  | 'create'
  | 'bot'
  | 'writer'
  | 'research'
  | 'curator'
  | 'planner'
  | 'cancel'
  | 'note'
  | 'tag'
  | 'warning'
  | 'checkCircle'
  | 'zoomIn'
  | 'zoomOut'
  | 'fitScreen'

/**
 * App icon key → Material Symbols ligature
 * (snake_case names from Google Icons catalog)
 */
export const MATERIAL_ICON: Record<IconName, string> = {
  dashboard: 'dashboard',
  file: 'description',
  folder: 'folder',
  folderOpen: 'folder_open',
  graph: 'hub',
  search: 'search',
  settings: 'settings',
  plus: 'add',
  close: 'close',
  chevronRight: 'chevron_right',
  sidebar: 'view_sidebar',
  panelRight: 'vertical_split',
  trash: 'delete',
  save: 'save',
  copy: 'content_copy',
  append: 'playlist_add',
  chat: 'chat',
  bold: 'format_bold',
  italic: 'format_italic',
  heading: 'title',
  link: 'link',
  check: 'check_box',
  code: 'code',
  quote: 'format_quote',
  preview: 'visibility',
  template: 'note_add',
  daily: 'calendar_today',
  openFolder: 'folder_open',
  create: 'create_new_folder',
  bot: 'smart_toy',
  writer: 'edit',
  research: 'manage_search',
  curator: 'account_tree',
  planner: 'checklist',
  cancel: 'cancel',
  note: 'sticky_note_2',
  tag: 'sell',
  warning: 'warning',
  checkCircle: 'check_circle',
  zoomIn: 'zoom_in',
  zoomOut: 'zoom_out',
  fitScreen: 'fit_screen'
}

export interface IconProps {
  name: IconName
  size?: number
  className?: string
  /** Kept for API compatibility; maps roughly to optical weight via fontVariationSettings */
  strokeWidth?: number
  style?: React.CSSProperties
  title?: string
  /** Material fill: 0 outline, 1 filled */
  fill?: 0 | 1
}

/**
 * Google Material Symbols Outlined icon.
 * Requires Material Symbols font loaded (see index.html / globals.css).
 */
export const Icon: React.FC<IconProps> = ({
  name,
  size = 16,
  className,
  strokeWidth,
  style,
  title,
  fill = 0
}) => {
  const glyph = MATERIAL_ICON[name]
  if (!glyph) return null

  // strokeWidth 1.5–2 → weight ~300–500 for similar visual weight to old SVG strokes
  const weight =
    strokeWidth != null
      ? Math.round(Math.min(700, Math.max(200, 200 + strokeWidth * 100)))
      : 400

  return (
    <span
      className={['wg-icon', 'material-symbols-outlined', className].filter(Boolean).join(' ')}
      style={{
        fontSize: size,
        width: size,
        height: size,
        lineHeight: 1,
        fontVariationSettings: `'FILL' ${fill}, 'wght' ${weight}, 'GRAD' 0, 'opsz' ${Math.min(48, Math.max(20, size))}`,
        ...style
      }}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      title={title}
    >
      {glyph}
    </span>
  )
}

export default Icon
