<template>
  <div>
    <div class="container">
      <v-tabs v-model="tab">
        <v-tab value="notebooks">Files</v-tab>
      </v-tabs>
      <div class="toolbar">
        <v-btn class="toolbar-btn" @click="openFile" color="primary" size="sm" outline dense>
          <v-icon icon="$file"></v-icon>
          <v-tooltip activator="parent" top>Open File</v-tooltip>
        </v-btn>
        <v-btn class="toolbar-btn" @click="openDir" color="primary" size="sm" outline dense>
          <v-icon icon="$folder"></v-icon>
          <v-tooltip activator="parent" top>Open Folder</v-tooltip>
        </v-btn>
        <!-- <v-btn @click="() => onEvent('download')" color="primary" :disable="!selectedAny" size="sm" outline dense>
        <v-icon name="mdi-download"></v-icon>
        <v-tooltip activator="parent" top>Download</v-tooltip>
      </v-btn>
      <v-btn @click="() => onEvent('copy')" color="primary" :disable="!selectedAny" size="sm" outline dense>
        <v-icon name="mdi-content-copy"></v-icon>
        <v-tooltip activator="parent" top>Copy</v-tooltip>
      </v-btn>
      <v-btn @click="() => onEvent('cut')" color="primary" :disable="!selectedAny" size="sm" outline dense>
        <v-icon name="mdi-content-cut"></v-icon>
        <v-tooltip activator="parent" top>Cut</v-tooltip>
      </v-btn>
      <v-btn @click="() => onEvent('paste')" color="primary" size="sm" outline dense>
        <v-icon name="mdi-content-paste"></v-icon>
        <v-tooltip activator="parent" top>Paste</v-tooltip>
      </v-btn> -->
        <v-btn class="toolbar-btn" @click="() => onToolbarAction('remove')" color="black" :disabled="!selectedAny"
          size="sm" outline dense>
          <v-icon icon="$delete"></v-icon>
          <v-tooltip activator="parent" top>Detach</v-tooltip>
        </v-btn>
      </div>

      <v-spacer class="spacer"></v-spacer>

      <div class="drop-section">
        <div ref="dropZoneRef" class="dropzone">
          <div v-if="isOverDropZone" class="drop-overlay"></div>

          <div class="filelist">
            <NestedListItem @select="onSelect" :selectable="true" v-if="storageStore.root" :file="storageStore.root"
              @prompt-permission="requestPermission"></NestedListItem>
          </div>
        </div>
      </div>
      <v-spacer class="spacer"></v-spacer>
    </div>
    <v-snackbar v-model="showError" :timeout="6000">{{ error }}</v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watchEffect, type PropType } from 'vue';
import { useDropZone } from '@vueuse/core';
import type { FileSystemReference } from "@/entities/FileSystemReference";
import { useStorageStore } from "@/store/storage";
import NestedListItem from './NestedListItem.vue';
import constants from '@/constants/constants';


let emit = defineEmits([
  'import',
  'download',
  'copy',
  'cut',
  'paste',
  'remove'
]);

let props = defineProps({
  files: {
    type: Object as PropType<FileSystemReference[]>,
    required: true
  }
});
let storageStore = useStorageStore();

let selected = ref<{ [key: string]: boolean }>({});
let tab = ref();
let error = ref('');
let showError = ref(false);
let dropZoneRef = ref();
let cwd = ref<FileSystemReference>();
let { isOverDropZone } = useDropZone(dropZoneRef, onDrop);
let selectedAny = computed(() => Object.values(selected.value).reduce((x, y) => x || y, false));

onMounted(async () => {
  await storageStore.refresh();
  cwd.value = storageStore.root;
  console.log("CWD: ", cwd.value);
  showError.value = !window.showDirectoryPicker;
  error.value = constants.ERROR_FS_API_NOT_SUPPORTED;
});

watchEffect(() => {
  console.log("watching")
  for (let fileRef of props.files) {
    selected.value[fileRef.path] = false;
  }
});


async function openFile() {
  if (!window.showOpenFilePicker) {
    showError.value = true;
    error.value = constants.ERROR_FS_API_NOT_SUPPORTED
    return;
  }
  const files = await window.showOpenFilePicker({
    excludeAcceptAllOption: false,
    mode: 'read', multiple: true, types: [
      {
        description: "text",
        accept: {
          "text/csv": [".csv"]
        }
      },
      {
        description: "binary",
        accept: {
          "application/octect-stream": [".parquet"],
        }
      }
    ]
  }) as FileSystemFileHandle[];

  cwd.value = await storageStore.attachFiles(files);
  emit("import", storageStore.root);
}

function onSelect(selection: { [key: string]: boolean }) {
  console.log(selection);
  selected.value = selection;
}

async function openDir() {
  if (!window.showOpenFilePicker) {
    showError.value = true;
    error.value = constants.ERROR_FS_API_NOT_SUPPORTED
    return;
  }
  const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite', multiple: false }) as FileSystemDirectoryHandle;
  cwd.value = await storageStore.attachDirectory(dirHandle);

  emit("import", storageStore.root);
}

function onToolbarAction(event: 'remove' | 'copy' | 'cut' | 'download') {
  let files = [];
  for (let fil in selected.value) {
    if (selected.value[fil]) {
      let matches = props.files.filter(f => f.path === fil);
      if (matches && matches.length > 0) files.push(matches[0]);
    }
  }
  emit(event, files);
}

function onNavigate(dir: FileSystemReference) {
  if (dir.type !== 'folder') return;
  cwd.value = dir;
  console.log("Explorer folder: ", cwd.value);
}

function onNavigateUpward() {
  // let parent = getParentDir(vmFolder.value);

  if (!cwd.value?.parent) return;
  onNavigate(cwd.value.parent);
}


function onDrop(files: File[] | null) {

  if (!files) return;

  // emit('import', createReferences(vmFolder.value, files));
}

async function requestPermission(file: FileSystemReference) {
  await file.handle?.requestPermission({
    mode: 'readwrite'
  });
  await storageStore.refresh();
  emit('import', storageStore.root);
}

</script>

<style lang="less" scoped>
.title {
  font-size: 2rem;
}

.container {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 8px;

  .spacer {
    border-bottom: solid rbg(var(--theme-color-border)) 1px;
    margin: 8px 0 8px 0;
    width: 100%;
    flex: 0;
  }

  .drop-section {
    flex: 1;

    .dropzone {
      height: 100%;
      /* min-height: 200px; */
      width: 100%;
    }

    .drop-overlay {
      position: absolute;
      height: 100%;
      width: 100%;
      top: 0;
      left: 0;
      background-color: var(--theme-color-accent);
    }

    .listitem {
      align-items: center;
      display: flex;
      flex-direction: row;
      margin-right: auto;

      .checkbox {
        margin-right: 5px;
      }

      .filename {
        margin-left: 7px;
        display: inline-block;
        text-overflow: ellipsis;
        overflow: hidden;
        white-space: nowrap;
      }

    }
  }

  .toolbar {
    .toolbar-btn {
      margin: 8px 2px 2px 2px;
    }
  }

}
</style>