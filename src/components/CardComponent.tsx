import type { Card } from '../lib/blackjack';

const SUIT_SYMBOLS: Record<string, string> = {
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
  spades: '♠',
};

const RED_SUITS = new Set(['hearts', 'diamonds']);

type Props = { card: Card };

export default function CardComponent({ card }: Props) {
  if (card.faceDown) {
    return (
      <div className="card face-down">
        <div className="card-back-pattern" />
      </div>
    );
  }

  const symbol = SUIT_SYMBOLS[card.suit];
  const colorClass = RED_SUITS.has(card.suit) ? 'red' : 'black';

  return (
    <div className={`card face-up ${colorClass}`}>
      <div className="card-top">
        <span>{card.value}</span>
        <span className="card-suit">{symbol}</span>
      </div>
      <div className="card-bottom">
        <span>{card.value}</span>
        <span className="card-suit">{symbol}</span>
      </div>
    </div>
  );
}
