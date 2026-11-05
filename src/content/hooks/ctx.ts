// Contexto compartilhado pelos hooks do MAIN world.
import type { Mode } from '../../shared/types';
import type { PageToBridge } from '../../shared/messages';

export interface PageState { enabled: boolean; mode: Mode }

export interface HookCtx {
  /** Estado atual; desconhecido ⇒ ON/fail (spec §3.3). */
  getState(): PageState;
  /** Envia para a ponte (enfileira até a ponte responder). */
  emit(msg: PageToBridge): void;
  newId(): string;
  /** Stack da chamada da aplicação, sem frames da extensão. */
  captureStack(): string;
  /** Registra ações de Liberar/Descartar de uma requisição HELD (Task 8). */
  registerHeld(hookId: string, release: () => void, discard: () => void): void;
  /** Notifica mudanças de estado (ex.: fechar conexões vivas ao ligar). */
  onStateChange(cb: (s: PageState) => void): void;
}
