// The widget registry: data-widget="<name>" in a dashboard file renders
// WIDGETS[name] with every other data-* attribute as a string option
// (camelCased, e.g. data-show → opts.show). A widget fills its grid cell (its
// <section class="w w--<name>">). Each widget's CSS is @imported in
// styles/app.css.
import type { ComponentType } from 'react'
import { Clock } from './Clock'
import { Weather } from './Weather'
import { CalendarWidget } from './Calendar'
import { PhotosWidget } from './Photos'
import { StarsWidget } from './Stars'

export interface WidgetProps { opts: Record<string, string> }

export const WIDGETS: Record<string, ComponentType<WidgetProps>> = {
  clock: Clock,
  weather: Weather,
  calendar: CalendarWidget,
  photos: PhotosWidget,
  stars: StarsWidget,
}

// "a,b" → ['a','b']; missing → fallback
export function list(value: string | undefined, fallback: string[]): string[] {
  if (value == null || value === '') return fallback
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}
export function num(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return value == null || value === '' || isNaN(n) ? fallback : n
}
