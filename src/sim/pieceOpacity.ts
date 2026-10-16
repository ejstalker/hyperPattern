/**
 * How a held pattern piece is drawn.
 *
 * The two states are deliberate steps on the same scale: a frozen piece still
 * drapes with the cloth and only has its own motion stopped, so it reads as
 * slightly dimmed; a ghosted piece is out of the simulation and only kept as a
 * reference pose, so it reads as a suggestion of fabric. The renderer switches
 * to its blended pass as soon as either value is in play.
 */
export const FROZEN_PIECE_OPACITY = 0.75;
export const GHOSTED_PIECE_OPACITY = 0.25;
