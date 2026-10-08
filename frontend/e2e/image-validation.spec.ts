import {expect,test} from '@playwright/test';

for(const theme of ['light','dark'] as const)for(const width of [1366,390])test(`new build remains checking before publication: ${theme} ${width}`,async({page})=>{
  await page.setViewportSize({width,height:900});
  let done=false;
  await page.route('**/api/me/notifications',route=>route.fulfill({json:{notifications:[]}}));
  await page.route('**/api/me/preferences',route=>route.fulfill({json:{preferences:{theme,fontFamily:'system',fontScale:1,defaultAdbKeyId:null}}}));
  await page.route('**/api/admin/emulator-images',route=>route.fulfill({json:{
    registry:{mode:'builtin',builtinAddress:'registry.example.test',externalAddress:null,externalUsername:null,externalPasswordSet:false},
    builder:{id:'h1',name:'builder'},
    images:[{package:'system-images;android-34;google_apis;x86_64',tag:'34-google_apis-x86_64',api:34,minor:null,androidVersion:'14',device:'phone',flavor:'google_apis',abi:'x86_64',built:done,validated:done,digest:done?'sha256:'+'a'.repeat(64):null,builtAt:null,sizeMb:null,profiles:[],updateAvailable:false}],
    jobs:[{id:'runtime-job',package:'system-images;android-34;google_apis;x86_64',image:'registry.example.test/rdf-emulator:34-google_apis-x86_64',state:done?'done':'validating',progress:{step:28,steps:28,percent:100},log:[]}],
  }}));
  await page.goto('/#/admin/profiles');
  await page.getByRole('button',{name:'Каталог образов',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Каталог образов Google',exact:true});
  const row=dialog.locator('.emulator-catalog-item');
  await expect(row).toContainText('Проверка загрузки Android и ADB');
  await expect(row.locator('.emulator-catalog-state .activity-indicator')).toHaveCount(1);
  await expect(row.getByRole('checkbox')).toBeDisabled();
  await expect(row.locator('.emulator-catalog-progress')).toHaveCount(0);
  await expect(row.getByRole('button',{name:'Остановить сборку Android 14 · Google APIs'})).toBeEnabled();
  await page.evaluate(()=>document.fonts.ready);
  const alignment=await dialog.locator('.emulator-catalog-filters select').evaluateAll(selects=>{
    const boxes=selects.map(element=>element.getBoundingClientRect());
    return boxes.every((box,index)=>boxes.every((other,j)=>index===j||Math.abs(box.top-other.top)>5||(Math.abs(box.top-other.top)<=1&&Math.abs(box.height-other.height)<=1)));
  });
  expect(alignment).toBe(true);
  const overflow=await dialog.evaluate(element=>Math.max(element.scrollWidth-element.clientWidth,element.querySelector('.emulator-catalog-body')!.scrollWidth-element.querySelector('.emulator-catalog-body')!.clientWidth,document.documentElement.scrollWidth-innerWidth));
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({path:`../.tmp-ui/image-validation-${theme}-${width}.png`});
  await dialog.getByRole('combobox',{name:'Состояние',exact:true}).selectOption('active');
  await expect(row).toHaveCount(1);
  await dialog.getByRole('combobox',{name:'Состояние',exact:true}).selectOption('');
  done=true;
  await expect(row).toContainText('Собран и проверен',{timeout:7000});
  await expect(row.getByRole('checkbox')).toBeEnabled();
  await expect(row.locator('.emulator-catalog-state .activity-indicator')).toHaveCount(0);
  await expect(row.locator('.emulator-catalog-cancel')).toHaveCount(0);
});
