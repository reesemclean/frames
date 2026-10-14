// The dashboard's own options (from its file), for widgets that default to
// them, e.g. the photos widget's interval and layout.
import { createContext, useContext } from 'react'
import type { DashboardOptions } from './types'

export const DashboardOptionsContext = createContext<DashboardOptions | null>(null)
export function useDashboardOptions(): DashboardOptions | null {
  return useContext(DashboardOptionsContext)
}
