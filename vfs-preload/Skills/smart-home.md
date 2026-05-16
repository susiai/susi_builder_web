# Smart home with Home Assistant

**Find this skill for** smart home, Home Assistant, lights, sensors, thermostat, Lampe, Licht, Temperatur.

## Before starting

Use the Home Assistant instance the user identifies. Confirm the target room or entity when the request is
ambiguous. Use an authorized connector or a shared Home Assistant tab. Keep access tokens in the user's
configured connection and out of skills, project files, and prompts.

## REST endpoints

Append these paths to the user's Home Assistant base URL. An authorized REST client uses the
`Authorization: Bearer <token>` header and sends JSON for POST requests.

| Goal | Method and path | Input |
| --- | --- | --- |
| Find an entity by name | `GET /api/states` | Filter the returned entities by domain and friendly name |
| Read a sensor or light | `GET /api/states/{entity_id}` | Use the actual entity ID |
| Discover available actions | `GET /api/services` | Read the actions for the relevant domain |
| Turn on a light | `POST /api/services/light/turn_on` | Example body: `{"entity_id":"light.kitchen"}` |
| Turn off a light | `POST /api/services/light/turn_off` | Use the same entity ID in the body |

For a temperature sensor, report its value and the supplied unit. For a change, use the named action only when
the user requested it, then check the entity again and report the observed state. With a shared browser tab,
follow Browser's approval flow. If no authorized connection is available, explain which action or endpoint to use.

[Home Assistant REST API](https://contributors.home-assistant.io/core/internals/rest-api/)
