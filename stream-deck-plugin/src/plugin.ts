// lastGLANCE for Stream Deck (docs/mcp-and-stream-deck.md, 6.3): registers the
// six actions and connects to the desktop app on this computer.
import streamDeck from '@elgato/streamdeck';
import { connection } from './shared';
import { ChoreAction } from './actions/chore';
import { DueAction } from './actions/due';
import { AddChoreAction, ComingUpAction, OverviewAction, ReachOutAction } from './actions/simple';

// The SDK runs action handlers as unawaited promises: a rejection would end the
// process, and every key with it.
process.on('unhandledRejection', (reason) => streamDeck.logger.error(`unhandled: ${String(reason)}`));

streamDeck.actions.registerAction(new ChoreAction());
streamDeck.actions.registerAction(new DueAction());
streamDeck.actions.registerAction(new OverviewAction());
streamDeck.actions.registerAction(new ReachOutAction());
streamDeck.actions.registerAction(new ComingUpAction());
streamDeck.actions.registerAction(new AddChoreAction());

connection.start();
streamDeck.connect().catch((err) => streamDeck.logger.error(`connect failed: ${err}`));
