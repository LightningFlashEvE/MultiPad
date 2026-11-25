import type { PetFurnitureId, PetPosition, PetWarehouse } from './petCatalog'
import type { PetParameter, PetState } from '../components/screenPage/petDisplay'

export type PetSettingsTab = 'scene' | 'stats' | 'items' | 'decor' | 'shop' | 'ai'
export type PetSettingsScreen = 0 | 1 | 2
export type ParameterPair = [PetParameter, PetParameter]

export interface PetSettingsSnapshot {
  view: { screen: PetSettingsScreen; tab: PetSettingsTab; selectedItem: number; revision: number }
  state: PetState
  petMode: boolean
  generation: number
  connected: boolean
  legacy: boolean
  busy: boolean
  session?: string
  sleeping: boolean
  followClock: boolean
  status: string
  bindings?: number[]
  warehouse?: PetWarehouse
  parameters: [ParameterPair, ParameterPair]
  previews: string[]
}

export type PetSettingsAction =
  | ['interact', number, number]
  | ['scene', 4 | 5 | 6, number]
  | ['follow-clock', boolean]
  | ['parameter', 1 | 2, number, PetParameter]
  | ['move', PetFurnitureId, PetPosition]
  | ['buy', number]
  | ['use', number]
  | ['toggle-lamp']
  | ['clear-notice']
