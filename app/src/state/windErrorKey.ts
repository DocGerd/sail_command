import { OpenMeteoError } from '../services/openMeteo';
import { ROUTING_FAILURE_MESSAGE_KEY } from './replan';
import type { MsgKey } from '../i18n/dict.de';

export function mapWindError(err: unknown): MsgKey {
  if (err instanceof OpenMeteoError) {
    switch (err.kind) {
      case 'offline':
        return 'error.offline';
      case 'rate-limited':
        return 'error.rateLimited';
      case 'http':
      case 'malformed':
        return 'error.windService';
    }
  }
  return ROUTING_FAILURE_MESSAGE_KEY['wind-unclassified'];
}
