.DEFAULT_GOAL := help

.PHONY: help install dev build check typecheck lint lint-fix format format-check test dev-escrow

help:
	@printf '%s\n' \
		'make install       Установить зависимости' \
		'make dev           Запустить игру для разработки' \
		'make build         Собрать dist/index.html' \
		'make check         Проверить типы, линтер и форматирование' \
		'make typecheck     Проверить типы TypeScript' \
		'make lint          Запустить ESLint' \
		'make lint-fix      Исправить замечания ESLint' \
		'make format        Отформатировать код' \
		'make format-check  Проверить форматирование' \
		'make test          Запустить локальный тест escrow' \
		'make dev-escrow    Запустить локальную цепочку с контрактом'

install:
	npm ci

dev:
	npm run dev

build:
	npm run build

check: typecheck lint format-check

typecheck:
	npm run check

lint:
	npm run lint

lint-fix:
	npm run lint:fix

format:
	npm run format

format-check:
	npm run format:check

test:
	npm run test:escrow

dev-escrow:
	npm run dev:escrow
