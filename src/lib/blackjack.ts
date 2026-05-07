export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type Value = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

export type Card = {
  suit: Suit;
  value: Value;
  faceDown?: boolean;
};

const SUITS: Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const VALUES: Value[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (let d = 0; d < 3; d++) {
    for (const suit of SUITS) {
      for (const value of VALUES) {
        deck.push({ suit, value });
      }
    }
  }
  return shuffleDeck(deck);
}

export function shuffleDeck(deck: Card[]): Card[] {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function dealCard(deck: Card[]): { card: Card; deck: Card[] } {
  const updated = [...deck];
  const card = updated.shift();
  if (!card) throw new Error('Deck is empty');
  return { card, deck: updated };
}

export function cardNumericValue(value: Value): number {
  if (['J', 'Q', 'K'].includes(value)) return 10;
  if (value === 'A') return 11;
  return parseInt(value, 10);
}

export function calculateHand(cards: Card[]): number {
  const visibleCards = cards.filter(c => !c.faceDown);
  let total = 0;
  let aces = 0;

  for (const card of visibleCards) {
    const v = cardNumericValue(card.value);
    if (card.value === 'A') aces++;
    total += v;
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }

  return total;
}

export function isBlackjack(cards: Card[]): boolean {
  return cards.length === 2 && calculateHand(cards) === 21;
}

export function isBust(cards: Card[]): boolean {
  return calculateHand(cards) > 21;
}

export function runDealerLogic(
  hand: Card[],
  deck: Card[]
): { finalHand: Card[]; updatedDeck: Card[] } {
  let currentHand: Card[] = hand.map(c => ({ ...c, faceDown: false }));
  let currentDeck = [...deck];

  while (calculateHand(currentHand) < 17) {
    const { card, deck: remaining } = dealCard(currentDeck);
    currentHand = [...currentHand, card];
    currentDeck = remaining;
  }

  return { finalHand: currentHand, updatedDeck: currentDeck };
}

// Two cards of equal numeric value (J+K allowed — both worth 10)
export function canSplit(cards: Card[]): boolean {
  if (cards.length !== 2) return false;
  return cardNumericValue(cards[0].value) === cardNumericValue(cards[1].value);
}

export function determineWinner(
  playerCards: Card[],
  dealerCards: Card[]
): 'win' | 'lose' | 'push' {
  const playerVal = calculateHand(playerCards);
  const dealerVal = calculateHand(dealerCards);
  const playerBJ = isBlackjack(playerCards);
  const dealerBJ = isBlackjack(dealerCards);

  if (playerVal > 21) return 'lose';
  if (dealerVal > 21) return 'win';
  if (playerBJ && dealerBJ) return 'push';
  if (playerBJ) return 'win';
  if (dealerBJ) return 'lose';
  if (playerVal > dealerVal) return 'win';
  if (playerVal < dealerVal) return 'lose';
  return 'push';
}
