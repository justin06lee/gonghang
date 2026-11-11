// The one file every component imports. Names on the left, shapes on the right.
export type Kitchen = {
  // Messages: someone sends, everyone listening hears.
  "order.placed": { table: number; dish: string };
  "order.ready": { table: number; dish: string };

  // Questions: someone asks, someone answers.
  price: (dish: string) => number;
};
