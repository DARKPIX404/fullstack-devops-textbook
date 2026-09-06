---
title: "Прототипы и классы"
description: "Прототипная цепочка под капотом, Object.create, геттеры и сеттеры, что на самом деле делает class из ES6, приватные поля #, статика и примеси."
---

До ES6 в JavaScript не было классов вообще — и при этом язык всегда поддерживал наследование. Секрет в **прототипах**: у каждого объекта есть скрытая ссылка на другой объект, и чтение свойства «проваливается» по цепочке прототипов вниз. Классы из ES6 — не новый механизм, а синтаксический сахар, который настраивает те же прототипы за вас.

Понимание прототипов критично: во-первых, ты будешь читать чужой код (и старый, и новый) годами. Во-вторых, многие «магические» свойства — `hasOwnProperty`, `toString`, поведение `this` в методах — это следствия цепочки. В-третьих, инструменты вроде примесей и фреймворочных base-классов строятся прямо на этом механизме.

## Прототипная цепочка

У каждого объекта есть внутреннее свойство `[[Prototype]]` (доступ к нему — через `Object.getPrototypeOf` или устаревшее `__proto__`). Когда ты читаешь свойство `obj.prop`, движок:

1. Ищет `prop` среди **собственных** свойств `obj`.
2. Не нашёл — переходит к `[[Prototype]]` и ищет там.
3. И так далее, пока не найдёт свойство или не дойдёт до `null` (обычно `Object.prototype` → `null`).

```js
const animal = {
  eats: true,
  walk() {
    console.log(`${this.name} передвигается`);
  },
};

const dog = Object.create(animal); // [[Prototype]] dog = animal
dog.name = 'Шарик';
dog.barks = true;

console.log(dog.barks); // true — собственное свойство
console.log(dog.eats);  // true — из прототипа animal
dog.walk();             // метод найден в animal, this === dog (!)

console.log(Object.getPrototypeOf(dog) === animal); // true
console.log(dog.hasOwnProperty('eats'));  // false — не собственное
console.log('eats' in dog);               // true — in проверяет ВСЮ цепочку
```

Обрати внимание на `this` в методе прототипа: когда `dog.walk()` вызывается, метод найден в `animal`, но `this` — это `dog` (правило «точка» из прошлой главы). Это и есть механизм «наследования» поведения: один метод — для многих объектов.

```js
const cat = Object.create(animal);
cat.name = 'Мурка';
cat.walk(); // «Мурка передвигается» — тот же метод, другой this
```

Метод **не копируется** в каждый объект — он хранится один раз в прототипе. Экономия памяти и возможность обновить поведение всех «наследников» правкой одного прототипа.

:::tip[Дно цепочки)]
У любого обычного объекта прототипная цепочка выглядит так: `obj → Object.prototype → null`. Поэтому у каждого объекта есть `toString`, `hasOwnProperty` и т.д. — они приходят из `Object.prototype`. `Object.create(null)` создаёт объект без прототипа — чистый словарь, без `toString` и прочих сюрпризов.
:::

## Как свойства создаются: присваивание vs определение

Чтение идёт по цепочке, а **присваивание** (`obj.x = 1`) всегда пишет в сам объект, даже если свойство есть в прототипе:

```js
const base = { count: 0 };
const derived = Object.create(base);

derived.count = 5;
console.log(derived.count); // 5 — собственное свойство
console.log(base.count);    // 0 — прототип не тронут
console.log(derived.hasOwnProperty('count')); // true
```

Если в прототипе есть **геттер без сеттера**, присваивание бросит ошибку в строгом режиме — типичный сюрприз:

```js
const ro = Object.create({ get x() { return 42; } });
ro.x = 1; // TypeError (strict): setter undefined
```

## Геттеры и сеттеры

Геттеры/сеттеры — это не поля, а функции доступа, оформленные как свойства. Они живут в прототипе так же, как методы:

```js
const temperature = {
  _celsius: 0,

  get fahrenheit() {
    return this._celsius * 9 / 5 + 32;
  },
  set fahrenheit(value) {
    this._celsius = (value - 32) * 5 / 9;
  },
};

temperature.fahrenheit = 212;
console.log(temperature._celsius); // 100
console.log(temperature.fahrenheit); // 212
```

Геттеры — мощный инструмент для вычисляемых свойств и «только для чтения» API (сеттер не объявляем). Но помни: они прячут вызов функции за синтаксисом поля, что усложняет отладку и профилирование.

## class в ES6: что под капотом

Синтаксис `class` — надстройка над прототипами. Разберём эквивалентность:

```js
class Animal {
  constructor(name) {
    this.name = name;
  }
  speak() {
    console.log(`${this.name} издаёт звук`);
  }
  static compare(a, b) {
    return a.name.localeCompare(b.name);
  }
}

// То же самое «руками»:
function AnimalManual(name) {
  this.name = name;
}
AnimalManual.prototype.speak = function () {
  console.log(`${this.name} издаёт звук`);
};
AnimalManual.compare = function (a, b) {
  return a.name.localeCompare(b.name);
};
```

Ключевые факты о классах:

- `constructor` — обычная функция-конструктор; `new Animal()` вызывает её с `this = {}`.
- Методы класса попадают в `Animal.prototype`, а не в экземпляры.
- **Строгий режим** внутри тела класса включён всегда.
- Класс нельзя вызвать без `new` (TypeError) — функции можно.
- Объявление класса **не поднимается** как function declaration (находится в TDZ).

## Наследование: extends и super

```js
class Dog extends Animal {
  constructor(name, breed) {
    super(name); // ОБЯЗАТЕЛЬНО до this — иначе ReferenceError
    this.breed = breed;
  }
  speak() {
    // super в методе: вызов метода прототипа (Animal.prototype)
    super.speak();
    console.log(`${this.name} (порода ${this.breed}) лает!`);
  }
}

const rex = new Dog('Рекс', 'овчарка');
rex.speak();
// «Рекс издаёт звук» ← из Animal.prototype через super
// «Рекс (порода овчарка) лает!»

console.log(Object.getPrototypeOf(Dog.prototype) === Animal.prototype); // true
console.log(Object.getPrototypeOf(rex) === Dog.prototype);              // true
```

Что настроил `extends` под капотом:

1. `Dog.prototype.[[Prototype]] = Animal.prototype` — методы Animal доступны через цепочку.
2. `Dog.[[Prototype]] = Animal` — статические методы наследуются: `Dog.compare(...)` работает.
3. Внутри конструктора `super(...)` — вызов конструктора родителя с текущим `this`.

Метод с `super` — не стрелка: стрелки не имеют `[[HomeObject]]`, который нужен для поиска `super`-метода в прототипе.

:::caution[Почему super() до this)]
До `super()` экземпляр ещё не инициализирован родительской частью. Доступ к `this` раньше `super()` в производном конструкторе — ReferenceError. В методах (не конструкторах) `super.method()` работает в любой позиции.
:::

## Псевдо-защищённые члены: соглашения и символы

Между публичным и приватным (`#`) есть промежуточная зона — «защищённые» члены, доступные наследникам, но не внешнему коду. JS не имеет синтаксиса для этого, поэтому используют соглашения или символы.

Соглашение с подчёркиванием — самое распространённое: `_internal`. Это договор, а не защита; код снаружи может обратиться, но линтеры (eslint `no-underscore-dangle`) и ревью отбивают руки:

```js
class BaseRepository {
  _connect() { /* ... */ }   // «защищено»: для наследников
  findAll() {
    this._connect();         // внутри иерархии — нормально
    // ...
  }
}
class UserRepository extends BaseRepository {
  findActive() {
    this._connect(); // наследник имеет доступ по соглашению
    // ...
  }
}
```

Символы дают более жёсткую защиту: свойство с ключом-символом не видно в `for...in`, `Object.keys` и JSON, хотя формально доступно по ссылке на символ:

```js
const SECRET = Symbol('secret');

class Vault {
  [SECRET] = 'скрытое значение';

  getSecret() { return this[SECRET]; }
}

const v = new Vault();
console.log(v.getSecret());       // «скрытое значение»
console.log(Object.keys(v));      // [] — символьные ключи не перечисляются
console.log(JSON.stringify(v));   // {} — не сериализуются
console.log(v[SECRET]);           // доступ есть, если символ утёк наружу
```

Для публичного API библиотеки `#` + публичные методы — правильный выбор; `_`-соглашение — для внутренней иерархии классов одного приложения; символы — для служебных метаданных, которые не должны светиться в сериализации.

## Встроенные объекты как прототипная иерархия

Всё, что ты ежедневно используешь — массивы, строки, промисы — построено на тех же прототипах. Полезно один раз увидеть цепочку целиком:

```js
const arr = [1, 2, 3];

// Цепочка прототипов массива:
// arr → Array.prototype → Object.prototype → null

console.log(Object.getPrototypeOf(arr) === Array.prototype);       // true
console.log(Object.getPrototypeOf(Array.prototype) === Object.prototype); // true

// Поэтому массив умеет И map, И toString:
console.log(arr.hasOwnProperty('map'));  // false — map из Array.prototype
console.log(arr.toString());             // «1,2,3» — toString из Object.prototype
console.log(arr.toReversed?.());         // новые методы — тоже в Array.prototype
```

Отсюда практическое следствие: **полифилы — это правка прототипа встроенных классов**. Если нужен метод, которого нет в старых браузерах, его добавляют в `Array.prototype`/`String.prototype` с проверкой:

```js
// Полифил: добавляем метод, только если его нет
if (!Array.prototype.toSorted) {
  Array.prototype.toSorted = function (compareFn) {
    return [...this].sort(compareFn); // не мутируем исходный
  };
}
```

Это легально именно потому, что методы живут в прототипе: одна правка — и все массивы в приложении получают возможность. Но помни граблю из раздела ошибок: расширять встроенные прототипы «для удобства» (не полифилы) — плохая практика. А вот читать их исходники — отличный способ понять язык: `Array.prototype.map` в спецификации описан обычным алгоритмом с `this`, `length` и `HasProperty`.

Цепочки наследования встроенных классов объясняют и экзотику: почему `typeof [] === 'object'`, почему `[] instanceof Object` — true, почему у функции есть `call`/`apply` (они в `Function.prototype`), а у функций-генераторов — `next` (в `GeneratorFunction.prototype`).

:::note[Чтение спецификации через прототипы)]
Разделы спеки «Properties of the Array Prototype Object» — это буквально список методов `Array.prototype`. Когда видишь «Let O be ? ToObject(this value)» — это перевод «создаём объект из this», тот самый this из прошлой главы. Прототипы, this и окружения — три кита, на которых стоит всё остальное.
:::

## instanceof и constructor: как устроены проверки

`instanceof` проверяет, есть ли `Constructor.prototype` в прототипной цепочке объекта — не более:

```js
class Animal {}
class Dog extends Animal {}

const rex = new Dog();

console.log(rex instanceof Dog);    // true — Dog.prototype в цепочке
console.log(rex instanceof Animal); // true — Animal.prototype тоже в цепочке
console.log(rex instanceof Object); // true — Object.prototype в конце

console.log(Object.getPrototypeOf(rex) === Dog.prototype); // true
console.log(Dog.prototype.isPrototypeOf(rex));             // true — тот же тест
```

Под капотом: `rex instanceof Dog` ≈ `Dog.prototype.isPrototypeOf(rex)`. Отсюда ограничения:

- `instanceof` ломается при смене прототипа (`Object.setPrototypeOf`) и при работе с объектами из других iframe/Realm (у них свой `Array.prototype` — `[] instanceof Array` вернёт false для чужого массива).
- Проверка «планого объекта» через `obj.constructor === Object` ненадёжна: `constructor` — обычное свойство прототипа, которое легко перезаписать или потерять при `Object.create(null)`.

```js
const fake = Object.create(Dog.prototype);
console.log(fake instanceof Dog); // true! При этом fake — не настоящий Dog:
console.log(fake instanceof Dog && !(fake instanceof Animal)); // false — цепочка та же
```

Для надёжных проверок типов используй `Array.isArray`, `typeof`, `Object.prototype.toString.call` или флаг-поле, а не `instanceof` через границы реалмов.

Ещё одна ловушка — `Object.setPrototypeOf`: он **меняет скрытый класс объекта**, что в V8 приводит к деоптимизации всего кода, работающего с этим объектом. Правило: задавай прототип при создании (`Object.create`, `class extends`), а не переставляй его в горячем коде.

## Приватные поля # и статика

Приватные поля — настоящая приватность на уровне языка, а не соглашения:

```js
class Wallet {
  #balance = 0;      // приватное поле, недоступно вне класса
  #transactions = [];

  static #maxTransaction = 10_000; // статика тоже бывает приватной
  static currency = 'RUB';           // публичная статика

  deposit(amount) {
    this.#validate(amount);
    this.#balance += amount;
    this.#transactions.push({ type: 'in', amount });
  }

  #validate(amount) { // приватный метод
    if (amount <= 0) throw new Error('Сумма должна быть положительной');
    if (amount > Wallet.#maxTransaction) throw new Error('Слишком крупная операция');
  }

  get balance() { return this.#balance; }
}

const w = new Wallet();
w.deposit(500);
console.log(w.balance);  // 500 — через геттер
// w.#balance             // SyntaxError: Private field must be declared
// w.#validate(1)         // SyntaxError
```

Важно: `#`-поля **не участвуют в наследовании** напрямую — приватность внутри класса, дочерний класс не видит `#`-поля родителя (но может пользоваться публичными/защищёнными методами). Если дочернему нужен доступ — выноси логику в protected-подобные методы без `#`.

Статика: принадлежит самому классу, не экземплярам. Применение — фабрики, константы, утилиты по классу:

```js
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  static notFound(what = 'Ресурс') {
    return new HttpError(404, `${what} не найден`);
  }
}

throw HttpError.notFound('Пользователь');
```

## Приватность: замыкание против #

Две модели приватности, которые ты уже встречал:

| Критерий | Замыкание | `#`-поля |
|---|---|---|
| Уровень | Переменные функции-фабрики | Синтаксис класса |
| Видимость в DevTools | Скрыто (только при отладке) | Видно, но недоступно из кода |
| Наследование | Ребёнок не получает автоматически | Не наследуется, нужны методы-доступы |
| Производительность | Окружение на каждый экземпляр | Поля объекта, оптимизировано V8 |

В современном коде на классах — `#`. В функциональном стиле и модулях — замыкания.

## Примеси (mixins)

JS не поддерживает множественное наследование классов, но прототипная природа позволяет «подмешивать» поведение. Примесь — объект/фабрика с методами, которые копируются в прототип класса или в сам класс:

```js
// Примесь: объект с методами
const Serializable = {
  toJSON() {
    return { ...this, type: this.constructor.name };
  },
};

const Timestamped = (Base) => class extends Base {
  constructor(...args) {
    super(...args);
    this.createdAt = new Date();
  }
};

// Применение: Object.assign в прототип
class Event { constructor(name) { this.name = name; } }
Object.assign(Event.prototype, Serializable);

console.log(JSON.stringify(new Event('deploy'))); // {"name":"deploy","type":"Event"}

// Функциональная примесь (mixin-функция): композиция через extends
class Job extends Timestamped(Event) {}
console.log(new Job('backup').createdAt instanceof Date); // true
```

Примеси полезны для переиспользования поведения без глубоких иерархий, но легко приводят к конфликтам имён — применяй осознанно.

## Типичные ошибки и грабли

1. **Итерация `for...in` по объекту с прототипом.** `for...in` идёт по всей цепочке. Лечится `hasOwnProperty`-фильтром или `Object.keys`/`Object.entries` (собственные только).

2. **Путать `in` и `hasOwnProperty`.** `'x' in obj` — вся цепочка; `obj.hasOwnProperty('x')` — только собственные.

3. **Ожидать копирования методов в экземпляры.** Методы в прототипе; перебор `for (const m in obj)` их увидит, `Object.keys` — нет. Это часто сбивает при сериализации.

4. **`this` в методе прототипа — не объект-прототип.** `animal.walk()` из `dog.walk()` даёт `this === dog`. Если нужен именно прототип — сохраняй его отдельно.

5. **Изменять встроенные прототипы** (`Array.prototype.myMethod = ...`). Полифилы — ок, «удобные» расширения — источник конфликтов с будущими версиями стандарта и чужими библиотеками. Вместо этого — утилиты или наследование (`class MyArray extends Array`).

6. **`super` в стрелочном методе или в конструкторе до инициализации.** В методах — стрелка ломает `super` (нет `[[HomeObject]]`), в конструкторе — ранний `this` до `super()` бросает ReferenceError.

## Вопросы на собеседовании

1. **Что такое прототипная цепочка?**
   Механизм поиска свойств: при чтении движок идёт по цепочке `[[Prototype]]` от объекта к `null`. Присваивание всегда пишет в самый объект.
2. **Чем `in` отличается от `hasOwnProperty`?**
   `in` проверяет всю цепочку прототипов, `hasOwnProperty` — только собственные свойства.
3. **Что делает `class` под капотом?**
   Создаёт функцию-конструктор, кладёт методы в её `prototype`, настраивает цепочки прототипов для наследования и статики. Синтаксический сахар над существующим механизмом.
4. **Зачем `super()` до `this` в наследуемом конструкторе?**
   До инициализации родительской части экземпляр не готов; ранний доступ к `this` — ReferenceError по спецификации.
5. **Наследуются ли приватные поля `#`?**
   Нет. `#`-поля приватны в рамках своего класса; наследники получают только публичные/защищённые-конвенционные интерфейсы.
6. **Как работают геттеры/сеттеры и где они живут при наследовании?**
   Это функции доступа, определённые через `get`/`set`; хранятся в прототипе, наследуются как обычные методы; присваивание без сеттера — ошибка в strict mode.

## Практика

1. Реализуй `inherit(proto)` — аналог `Object.create` через конструктор и `prototype` (без использования `Object.create`). Критерий: созданные объекты проходят `isPrototypeOf` и видят методы прототипа.
2. Напиши класс `Observable`: методы `on(event, fn)`, `off(event, fn)`, `emit(event, payload)`; сделай его примесью — перепиши как функцию `withObservable(Base)`, возвращающую класс-наследника с этим поведением. Критерий: `class Store extends withObservable(Object) {}` работает.
3. Создай `Temperature` с приватным `#kelvin`, публичными геттерами `celsius`/`fahrenheit` и сеттерами с валидацией (не ниже 0 K). Критерий: некорректное значение бросает RangeError, прямой доступ к `#kelvin` — SyntaxError.
4. Продемонстрируй разницу `Object.keys` и `for...in` на объекте с прототипом: напиши код, где оба подхода дают разные результаты, и объясни почему. Добавь безопасный вариант итерации собственных + унаследованных свойств с метками.
5. Реализуй `deepFreeze(obj)`: рекурсивно замораживает объект и вложенные объекты (Object.freeze + обход значений). Критерий: попытка изменить вложенный объект бросает TypeError в strict mode; массивы и `null` обрабатываются корректно.

## Что почитать

- [MDN: Наследование и прототипы](https://developer.mozilla.org/ru/docs/Web/JavaScript/Guide/Inheritance_and_the_prototype_chain)
- [MDN: Классы](https://developer.mozilla.org/ru/docs/Web/JavaScript/Reference/Classes)
- [MDN: Приватные свойства](https://developer.mozilla.org/ru/docs/Web/JavaScript/Reference/Classes/Private_properties)
- [V8 Blog: JavaScript class fields](https://v8.dev/features/class-fields)
- [Patterns.dev: Mixins](https://www.patterns.dev/posts/mixin-pattern/)
