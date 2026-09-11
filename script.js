const DATA_FILES = {
  base: "data/base-schedule.json",
  language: "data/language-schedule.json",
  physicalEducation: "data/physical-education.json"
};
const USERNAME_STORAGE_KEY = "aitu-schedule-username";
const DATA_REFRESH_INTERVAL = 30_000;

const scheduleBody = document.querySelector("#schedule-body");
const usernameSelect = document.querySelector("#username-select");
const showButton = document.querySelector("#show-schedule");
const scheduleInfo = document.querySelector("#schedule-info");
const lessonTemplate = document.querySelector("#lesson-template");
const previousDayButton = document.querySelector("#previous-day");
const nextDayButton = document.querySelector("#next-day");
const automaticDayButton = document.querySelector("#automatic-day");
const mobileDayLabel = document.querySelector("#mobile-day-label");
const groupDialog = document.querySelector("#group-dialog");
const closeGroupDialogButton = document.querySelector("#close-group-dialog");
const groupDialogTitle = document.querySelector("#group-dialog-title");
const groupDialogTags = document.querySelector("#group-dialog-tags");
const groupMembers = document.querySelector("#group-members");
let data;
let localStorageAvailable = true;
let manuallySelectedDay = null;

async function loadData() {
  // Метка времени и no-store исключают выдачу старого JSON из кеша браузера/CDN.
  const cacheBuster = Date.now();
  const responses = await Promise.all(
    Object.values(DATA_FILES).map((file) => fetch(`${file}?v=${cacheBuster}`, { cache: "no-store" }))
  );
  if (responses.some((response) => !response.ok)) {
    throw new Error("Не удалось загрузить один из файлов расписания.");
  }
  const [base, language, physicalEducation] = await Promise.all(responses.map((response) => response.json()));
  return { base, language, physicalEducation };
}

function makeLesson(lesson, state = "future") {
  const fragment = lessonTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".lesson");
  card.classList.add(`is-${state}`);
  card.querySelector(".lesson-title").textContent = lesson.subject;
  card.querySelector(".lesson-details").textContent = [lesson.room, lesson.extra].filter(Boolean).join(" · ");

  if (lesson.kind === "language") {
    card.classList.add("is-clickable");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Показать группу: ${lesson.subject}`);
    card.addEventListener("click", () => openLanguageGroup(lesson));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openLanguageGroup(lesson);
      }
    });
  }
  return fragment;
}

// Поддерживаются и текущий формат { users: [...] }, и один объект пользователя.
function getUsers(schedule) {
  if (Array.isArray(schedule)) return schedule;
  if (Array.isArray(schedule.users)) return schedule.users;
  return schedule.Username ? [schedule] : [];
}

function getUserLessons(username) {
  const languageUser = getUsers(data.language).find((user) => user.Username === username);
  const physicalUser = getUsers(data.physicalEducation).find((user) => user.Username === username);
  const lessons = [];

  if (languageUser) {
    languageUser.lections.forEach((lesson) => {
      lessons.push({
        day: lesson.day,
        subject: languageUser.language,
        start: lesson.time,
        end: lesson.end ?? lesson.time + 1,
        room: lesson.cab,
        extra: lesson.GroupId,
        kind: "language",
        languageTags: {
          day: lesson.day,
          time: lesson.time,
          end: lesson.end ?? lesson.time + 1,
          cab: lesson.cab || "",
          groupId: lesson.GroupId || "",
          language: languageUser.language
        }
      });
    });
  }
  if (physicalUser) {
    lessons.push({
      day: physicalUser.day,
      subject: "Физическая культура: " + physicalUser.Type,
      start: physicalUser.time,
      end: physicalUser.time + 2,
      room: physicalUser.room || ""
    });
  }
  return lessons;
}

function normalizeTag(value) {
  return String(value ?? "").trim().toLocaleLowerCase("ru-RU");
}

function isSameLanguageGroup(target, user, lesson) {
  const targetTags = target.languageTags;
  const candidateEnd = lesson.end ?? lesson.time + 1;
  const samePlaceAndTime =
    normalizeTag(lesson.day) === normalizeTag(targetTags.day) &&
    normalizeTag(lesson.time) === normalizeTag(targetTags.time) &&
    normalizeTag(candidateEnd) === normalizeTag(targetTags.end) &&
    normalizeTag(lesson.cab) === normalizeTag(targetTags.cab);

  if (!samePlaceAndTime) return false;
  if (targetTags.groupId || lesson.GroupId) {
    return normalizeTag(lesson.GroupId) === normalizeTag(targetTags.groupId);
  }
  return normalizeTag(user.language) === normalizeTag(targetTags.language);
}

function openLanguageGroup(target) {
  const members = new Set();
  getUsers(data.language).forEach((user) => {
    (user.lections || []).forEach((lesson) => {
      if (isSameLanguageGroup(target, user, lesson)) members.add(user.Username);
    });
  });

  groupDialogTitle.textContent = target.subject;
  groupDialogTags.textContent = `${target.languageTags.day} · ${target.languageTags.time}:00–${target.languageTags.end}:00 · ${target.languageTags.cab || "Кабинет не указан"}`;
  groupMembers.replaceChildren(
    ...[...members].sort().map((username) => {
      const item = document.createElement("li");
      item.textContent = username;
      return item;
    })
  );

  if (typeof groupDialog.showModal === "function") groupDialog.showModal();
  else groupDialog.setAttribute("open", "");
}

function getTodayDayIndex(now) {
  // Date.getDay(): воскресенье = 0; в расписании понедельник = 0.
  return (now.getDay() + 6) % 7;
}

function getMobileView(allLessons, now) {
  const { days } = data.base;
  const rawTodayIndex = getTodayDayIndex(now);
  // В воскресенье index становится -1: ближайший учебный день — понедельник.
  const todayIndex = rawTodayIndex >= days.length ? -1 : rawTodayIndex;
  const todayName = days[todayIndex];
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const todayLessons = todayName ? allLessons.filter((lesson) => lesson.day === todayName) : [];
  const lastLessonEndsAt = todayLessons.length
    ? Math.max(...todayLessons.map((lesson) => (lesson.end - 1) * 60 + 50))
    : -1;

  if (todayName && minutesNow < lastLessonEndsAt) {
    return { day: todayName, label: "Сегодня", isToday: true };
  }

  // После последней пары (или в воскресенье) ищем ближайший учебный день.
  for (let offset = 1; offset <= days.length; offset += 1) {
    const day = days[(todayIndex + offset) % days.length];
    if (allLessons.some((lesson) => lesson.day === day)) {
      const targetWeekday = days.indexOf(day) + 1; // Date: понедельник = 1
      const calendarOffset = (targetWeekday - now.getDay() + 7) % 7 || 7;
      return {
        day,
        label: calendarOffset === 1 ? "Завтра" : "Следующий учебный день",
        isToday: false
      };
    }
  }

  return { day: days[0], label: "Следующий учебный день", isToday: false };
}

function getLessonState(lesson, now, view) {
  if (!view.isToday || lesson.day !== view.day) return "future";

  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const lessonEndsAt = (lesson.end - 1) * 60 + 50;
  if (minutesNow >= lessonEndsAt) return "past";

  for (let hour = lesson.start; hour < lesson.end; hour += 1) {
    const slotStartsAt = hour * 60;
    const slotEndsAt = slotStartsAt + 50;
    if (minutesNow >= slotStartsAt && minutesNow < slotEndsAt) return "current";
  }
  return "future";
}

function applyMobileDay(day) {
  document.querySelectorAll("[data-day]").forEach((element) => {
    element.classList.toggle("mobile-hidden", element.dataset.day !== day);
  });
  mobileDayLabel.textContent = day;
}

function getDisplayedMobileView(allLessons, now) {
  const automaticView = getMobileView(allLessons, now);
  if (!manuallySelectedDay) return automaticView;

  const todayIndex = getTodayDayIndex(now);
  const todayName = data.base.days[todayIndex];
  return {
    day: manuallySelectedDay,
    label: "Просмотр",
    isToday: manuallySelectedDay === todayName
  };
}

function changeMobileDay(direction) {
  if (!data) return;

  const allLessons = [...data.base.lessons, ...getUserLessons(usernameSelect.value)];
  const currentDay = manuallySelectedDay || getMobileView(allLessons, new Date()).day;
  const currentIndex = data.base.days.indexOf(currentDay);
  const nextIndex = (currentIndex + direction + data.base.days.length) % data.base.days.length;
  manuallySelectedDay = data.base.days[nextIndex];
  renderSchedule();
}

function getSavedUsername() {
  try {
    return window.localStorage.getItem(USERNAME_STORAGE_KEY);
  } catch {
    localStorageAvailable = false;
    return null;
  }
}

function saveSelectedUsername() {
  try {
    window.localStorage.setItem(USERNAME_STORAGE_KEY, usernameSelect.value);
    localStorageAvailable = window.localStorage.getItem(USERNAME_STORAGE_KEY) === usernameSelect.value;
    return localStorageAvailable;
  } catch {
    // Расписание остаётся доступным, даже если браузер запретил localStorage.
    localStorageAvailable = false;
    return false;
  }
}

function renderSchedule() {
  const username = usernameSelect.value;
  const { base } = data;
  const allLessons = [...base.lessons, ...getUserLessons(username)];
  const now = new Date();
  const mobileView = getDisplayedMobileView(allLessons, now);
  const lessonsByPosition = new Map();
  const coveredPositions = new Set();
  allLessons.forEach((lesson) => {
    const key = `${lesson.day}-${lesson.start}`;
    const atPosition = lessonsByPosition.get(key) || [];
    atPosition.push(lesson);
    lessonsByPosition.set(key, atPosition);

    for (let hour = lesson.start + 1; hour < lesson.end; hour += 1) {
      coveredPositions.add(`${lesson.day}-${hour}`);
    }
  });

  scheduleBody.replaceChildren();
  for (let hour = 8; hour < 22; hour += 1) {
    const row = document.createElement("tr");
    const timeCell = document.createElement("th");
    timeCell.className = "time-cell";
    timeCell.scope = "row";
    timeCell.textContent = `${hour}:00–${hour}:50`;
    row.append(timeCell);

    base.days.forEach((day) => {
      if (coveredPositions.has(`${day}-${hour}`)) return;

      const cell = document.createElement("td");
      cell.className = "schedule-cell";
      cell.dataset.day = day;
      const lessons = lessonsByPosition.get(`${day}-${hour}`) || [];
      lessons.forEach((lesson) => {
        cell.append(makeLesson(lesson, getLessonState(lesson, now, mobileView)));
      });
      const longestLesson = Math.max(1, ...lessons.map((lesson) => lesson.end - lesson.start));
      if (longestLesson > 1) {
        cell.rowSpan = longestLesson;
        cell.classList.add("is-multi-slot");
        cell.style.setProperty("--lesson-slots", longestLesson);
      }
      row.append(cell);
    });
    scheduleBody.append(row);
  }

  const hasPersonalSchedule = getUserLessons(username).length > 0;
  const userScheduleText = hasPersonalSchedule
    ? `Базовое и персональное расписание для ${username}.`
    : `Для ${username} персональных занятий пока нет — показано базовое расписание.`;
  const storageWarning = localStorageAvailable ? "" : " Браузер запретил сохранение выбора.";
  scheduleInfo.textContent = `${mobileView.label}: ${mobileView.day}. ${userScheduleText}${storageWarning}`;
  applyMobileDay(mobileView.day);
}

function populateUsers(preferredUsername = getSavedUsername()) {
  const users = new Set();
  getUsers(data.language).forEach((user) => users.add(user.Username));
  getUsers(data.physicalEducation).forEach((user) => users.add(user.Username));
  const usernames = [...users].sort();
  usernameSelect.replaceChildren(...usernames.map((username) => new Option(username, username)));

  usernameSelect.value = usernames.includes(preferredUsername) ? preferredUsername : usernames[0];
  saveSelectedUsername();
}

async function refreshScheduleData() {
  const preferredUsername = data ? usernameSelect.value : getSavedUsername();
  const loadedData = await loadData();
  data = loadedData;
  populateUsers(preferredUsername);
  renderSchedule();
}

function saveAndRenderSchedule() {
  saveSelectedUsername();
  renderSchedule();
}

showButton.addEventListener("click", saveAndRenderSchedule);
usernameSelect.addEventListener("input", saveAndRenderSchedule);
usernameSelect.addEventListener("change", saveAndRenderSchedule);
window.addEventListener("pagehide", saveSelectedUsername);
previousDayButton.addEventListener("click", () => changeMobileDay(-1));
nextDayButton.addEventListener("click", () => changeMobileDay(1));
automaticDayButton.addEventListener("click", () => {
  manuallySelectedDay = null;
  renderSchedule();
});
closeGroupDialogButton.addEventListener("click", () => groupDialog.close());
groupDialog.addEventListener("click", (event) => {
  if (event.target === groupDialog) groupDialog.close();
});

// Обновляет время, а также подхватывает новые usernames и занятия из JSON.
window.setInterval(() => {
  refreshScheduleData().catch((error) => console.warn("Не удалось обновить расписание:", error));
}, DATA_REFRESH_INTERVAL);

window.addEventListener("focus", () => {
  if (data) refreshScheduleData().catch((error) => console.warn("Не удалось обновить расписание:", error));
});

refreshScheduleData()
  .catch((error) => {
    scheduleInfo.textContent = error.message;
    console.error(error);
  });
