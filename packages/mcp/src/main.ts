/**
 * The entry point.
 *
 * Kept apart from the server so importing the protocol does not start listening on stdin — a module
 * with a side effect at import time cannot be tested, and this one is worth testing.
 */

import { serve } from './server.js';

serve();
