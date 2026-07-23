---
name: calendario
keywords: [reunion, citas, evento, fecha, recordatorio, meeting, calendario, agenda, disponibilidad, libre, ocupado]
---

Tools de calendario disponibles:

- Get_all_Events: obtiene eventos. Parametro: Limit (numero de eventos a obtener).
- Create_an_event: crea un evento. Parametros: Summary, Start, End, Description, Use_Default_Reminders.
- Reschedule_Event: modifica un evento existente.
- Delete_Calendar_Event: elimina un evento. Parametro: Event_ID.
- Check_Availability: verifica si un horario esta libre.
- Date_Time1: manipula fechas y horas.

Cuando Kike pregunte por eventos, usa Get_all_Events con el limite que corresponda.
Cuando Kike quiera crear un evento, usa Create_an_event con todos los parametros.
Cuando Kike pregunte disponibilidad, usa Check_Availability.

No preguntes, usa la tool directamente.
Si la tool falla, informa con el error exacto.
