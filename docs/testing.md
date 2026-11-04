# Как гонять тесты

Полный прогон — `npm test`, гейт самоизменения — `npm run gate`. Оба рассчитаны
на каталог, куда можно писать: vitest создаёт рядом с конфигом временный
`.vite-temp` и кладёт API-токен в `~/.local/share/vitest`.

В read-only checkout (у бота каталог `app` смонтирован только на чтение) эти две
записи падают:

```
ENOENT: mkdir .../node_modules/.vite-temp
Failed to create Vitest API token at ~/.local/share/vitest/.vitest-secret-token
```

Это не «vitest не запускается»: оба отказа снимаются маршрутами, а не правами.

- `--configLoader runner` грузит конфиг напрямую, без временного файла рядом с ним.
- `XDG_DATA_HOME` уводит токен в записываемый каталог (vitest создаёт его сам).
- Кеш уже вне репозитория: `vitest.config.ts` держит его в `tmpdir()`.

## Один тест

```bash
cd app
XDG_DATA_HOME="${TMPDIR:-/tmp}/dshbot-vitest-data" \
  node_modules/.bin/vitest run --configLoader runner packages/app/src/inline-photo.test.ts
```

Путь к файлу можно заменить фильтром по имени (`-t 'картинка'`) или каталогом
пакета. Один файл проходит за доли секунды — это дешевле полного гейта, когда
нужно проверить правку перед кандидатом.

`cd app` здесь — это `$DSHBOT_HOME/app`. Из песочницы `exec` такого пути нет: её
рабочий каталог — `workspace`, а `DSHBOT_HOME` не выставлен, так что `cd app`
отвечает `No such file or directory`. Оттуда нужен абсолютный путь
(например, `cd /home/user/.local/share/dshbot/app`, заменив `user` именем пользователя установки) или `cd ../app`.

## Что всё-таки требует гейта

Запуск отдельного файла не заменяет `npm run gate`: типизация (`tsc --noEmit`) и
`vitest related` по затронутым файлам остаются за гейтом. Часть тестов гейта
не проходит во вложенной песочнице (тесты самого гейта, бенча демона и
`packages/factory/**`) — это отличие вложенного прогона, а не регрессия правки.

## Красное только в гейте

Правка в `packages/runner` тянет за собой `packages/factory` по цепочке
импортов, а там есть два предсказуемо красных в песочнице теста:

- `execution-recovery.test.ts` — `git worktree add … fatal: not a git repository:
  /tmp/dshbot-factory-worktrees-…/.git`. В песочницу гейта не смонтирован gitdir
  кандидата: `.git` там файл-указатель на `app/.git/worktrees/<id>`.
- `execution-gate-light.test.ts`, тест `c6` — `Test timed out in 5000ms` на
  вложенном bwrap.

Оба зелёные в живом каталоге: `execution-recovery.test.ts` — 5 из 5 за 4,7 с
(проверено 29.10.2026). Поэтому упавший в гейте файл сначала прогони здесь, по
рецепту из раздела «Один тест»: зелёный в `app` и красный в гейте означает
окружение, а не твою правку. Подгонять такой тест под кандидата нельзя — он
чужой и проверяет сам завод; правку в этом случае передают заводу.
